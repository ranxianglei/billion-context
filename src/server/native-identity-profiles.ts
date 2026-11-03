/**
 * #5573 M1 (L1) — native-identity profile table (pure observation data).
 *
 * One row per known client family. Each profile declares: how to RECOGNIZE it
 * on the wire (match headers / protocol), which header carries each identity
 * granularity (session / turn / message), its explicit compaction signals,
 * bounded text patterns counted over the (already decoded) body, and the
 * compaction-preface texts its own compressor emits. Rows are DATA, not
 * scattered comparisons: adding a client or correcting a drifted preface
 * (each preface comes from independent binary forensics and CAN drift with
 * client versions) is a table edit + a fixture test, not an architecture
 * change. The env override (BILI_NATIVE_IDENTITY_PROFILES_JSON) may ADD or
 * REPLACE rows by name but never remove built-ins — the built-in table is the
 * floor (#5573 M1 design).
 *
 * All matching is lowercase-header-name based (Node lowercases inbound
 * headers); body patterns are literal substrings located with indexOf — no
 * regex, no JSON.parse (the chokepoint holds decoded BYTES, and parsing them
 * is exactly the work #5403 removed from the hot path).
 */

interface NativeIdPattern {
    /** Literal substring to locate/count in the decoded body text. */
    pattern: string;
    /** Label for the count in the observation line (short, grep-able). */
    label: string;
    /** When true, a NON-zero count is itself an anomaly (protocol drift) and
     *  raises a shape_assert_fail event; such counts are always reported. */
    assertZero?: boolean;
}

export interface NativeIdProfileDef {
    name: string;
    /** Any of these headers present (non-empty) makes the profile a match. */
    matchHeaders: readonly string[];
    /** Secondary match: this header must be present AND the wire protocol matches. */
    secondaryMatch?: { header: string; protocol: string };
    /** Protocol-only match (no header evidence), e.g. the Google wire. */
    matchProtocol?: string;
    /** Session-level id candidates, first hit wins. */
    sessionHeaders: readonly string[];
    /** The session header's value must start with this prefix (shape gate). */
    sessionValuePrefix?: string;
    /** Turn/thread-level marker candidates. */
    turnHeaders: readonly string[];
    /** Message-level id candidates (retry-stable where the host guarantees it). */
    msgidHeaders: readonly string[];
    /** Explicit compaction EVENT header (host attached it because IT just compacted). */
    compactionEdgeHeader?: string;
    /** Compaction STATE header (this context was compacted — corroboration, never a trigger). */
    compactionLevelHeader?: string;
    /** Values logged/stored as sha1-8 digest only (PII class, e.g. installation ids). */
    piHeaders: readonly string[];
    /** Informational host-fingerprint headers (name=value in the line tail). */
    fingerprintHeaders: readonly string[];
    /** Bounded substring counts over the body text (item-id families, anchor counts). */
    countPatterns: readonly NativeIdPattern[];
    /** Compaction-preface texts: occurrence inside a USER element = compaction event. */
    compactionPrefixes: readonly string[];
    /** Path suffix that is itself a compaction event (e.g. /responses/compact). */
    compactionPathSuffixes?: readonly string[];
    /** Dual-channel cross-check: body value that must equal the session header
     *  (mismatch = incident event). Located by a bounded windowed text walk. */
    dualSessionBodyAnchor?: { anchor: string; field: string; window: number };
    /** Top-level body field tracked for rotation (e.g. previous_response_id). */
    rotationBodyField?: string;
}

const BUILTIN_PROFILES: readonly NativeIdProfileDef[] = [
    {
        name: "wb",
        matchHeaders: ["x-conversation-id"],
        sessionHeaders: ["x-conversation-id"],
        turnHeaders: ["x-conversation-request-id"],
        msgidHeaders: ["x-conversation-message-id", "x-request-id"],
        compactionEdgeHeader: "x-compaction",
        compactionLevelHeader: "x-context-compacted",
        piHeaders: [],
        fingerprintHeaders: ["x-codebuddy-request", "x-ide-name", "x-ide-type", "x-ide-version"],
        countPatterns: [],
        compactionPrefixes: [],
    },
    {
        name: "codex",
        matchHeaders: ["x-codex-installation-id"],
        secondaryMatch: { header: "x-client-request-id", protocol: "responses" },
        sessionHeaders: ["session-id", "thread-id", "x-codex-window-id"],
        turnHeaders: ["x-codex-turn-metadata", "turn-id"],
        msgidHeaders: ["x-client-request-id", "x-request-id"],
        piHeaders: ["x-codex-installation-id"],
        fingerprintHeaders: [],
        countPatterns: [
            { pattern: "\"msg_", label: "msg_" },
            { pattern: "\"ctc_", label: "ctc_" },
            { pattern: "\"ctco_", label: "ctco_" },
            { pattern: "\"rs_", label: "rs_" },
            { pattern: "\"internal_chat_message_metadata_passthrough\"", label: "turnmeta" },
        ],
        compactionPrefixes: ["Another language model started to solve this problem"],
        compactionPathSuffixes: ["/responses/compact"],
        rotationBodyField: "previous_response_id",
    },
    {
        name: "cc",
        matchHeaders: ["x-claude-code-session-id"],
        sessionHeaders: ["x-claude-code-session-id"],
        turnHeaders: [],
        msgidHeaders: [],
        piHeaders: [],
        fingerprintHeaders: [],
        countPatterns: [{ pattern: "toolu_", label: "toolu" }],
        compactionPrefixes: ["This session is being continued from a previous conversation"],
        dualSessionBodyAnchor: { anchor: "\"user_id\"", field: "\"session_id\"", window: 512 },
    },
    {
        name: "opencode",
        matchHeaders: ["x-session-affinity", "x-opencode-session-id"],
        sessionHeaders: ["x-session-affinity", "x-opencode-session-id"],
        sessionValuePrefix: "ses_",
        turnHeaders: ["x-parent-session-id"],
        msgidHeaders: [],
        piHeaders: [],
        fingerprintHeaders: [],
        // Assertive counts: these shapes are NOT expected on opencode's outbound
        // model wire; a non-zero count means upstream protocol drift (event).
        countPatterns: [
            { pattern: "ses_", label: "ses_", assertZero: true },
            { pattern: "msg_", label: "msg_", assertZero: true },
            { pattern: "prt_", label: "prt_", assertZero: true },
        ],
        compactionPrefixes: ["What did we do so far?", "<previous-summary>"],
    },
    {
        name: "gemini",
        matchHeaders: [],
        matchProtocol: "google",
        sessionHeaders: [],
        turnHeaders: [],
        msgidHeaders: [],
        piHeaders: [],
        fingerprintHeaders: [],
        countPatterns: [],
        compactionPrefixes: ["<state_snapshot>"],
    },
];

let envOverrideWarned = false;

/** Resolve the active profile table: built-ins are the floor; the env JSON may
 *  add/replace rows by name, never remove built-ins. Malformed env JSON is
 *  ignored (fail-open, one warn per process). */
function nativeIdProfiles(): readonly NativeIdProfileDef[] {
    const raw = process.env["BILI_NATIVE_IDENTITY_PROFILES_JSON"];
    if (raw === undefined || raw.trim().length === 0) return BUILTIN_PROFILES;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        const overrides = parsed as Record<string, Partial<NativeIdProfileDef>>;
        const merged: NativeIdProfileDef[] = BUILTIN_PROFILES.map((p) => ({ ...p }));
        const byName = new Map(merged.map((p) => [p.name, p]));
        for (const [name, patch] of Object.entries(overrides)) {
            if (patch === null || typeof patch !== "object") continue;
            const existing = byName.get(name);
            if (existing !== undefined) {
                Object.assign(existing, patch, { name });
            } else {
                merged.push({
                    name,
                    matchHeaders: [],
                    sessionHeaders: [],
                    turnHeaders: [],
                    msgidHeaders: [],
                    piHeaders: [],
                    fingerprintHeaders: [],
                    countPatterns: [],
                    compactionPrefixes: [],
                    ...patch,
                } as NativeIdProfileDef);
            }
        }
        return merged;
    } catch {
        if (!envOverrideWarned) {
            envOverrideWarned = true;
            // loggerLog-free on purpose: this module must stay import-light;
            // the caller surfaces nothing — a bad override silently keeps the
            // built-ins (fail-open, observation layer only).
        }
        return BUILTIN_PROFILES;
    }
}

/** First matching profile, fixed priority wb → codex → cc → opencode → gemini →
 *  unknown. Plugin-lane traffic (agent-stamped) resolves to the AGENT name
 *  upstream of this table — those identities are bili-trusted, not forensics. */
export function resolveNativeIdProfile(
    headers: Record<string, string | string[] | undefined>,
    protocol: string | null | undefined,
): NativeIdProfileDef & { name: string } {
    const present = (name: string): boolean => {
        const v = headers[name];
        return typeof v === "string" && v.trim().length > 0;
    };
    for (const p of nativeIdProfiles()) {
        if (p.matchHeaders.some(present)) return p;
        if (p.secondaryMatch !== undefined && present(p.secondaryMatch.header) && protocol === p.secondaryMatch.protocol) return p;
        if (p.matchProtocol !== undefined && protocol === p.matchProtocol) return p;
    }
    return UNKNOWN_PROFILE;
}

const UNKNOWN_PROFILE: NativeIdProfileDef & { name: string } = {
    name: "unknown",
    matchHeaders: [],
    sessionHeaders: [],
    turnHeaders: [],
    msgidHeaders: [],
    piHeaders: [],
    fingerprintHeaders: [],
    countPatterns: [],
    compactionPrefixes: [],
};
