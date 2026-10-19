// #3638: classified, bounded, secret-free external-summary failure diagnostics
// + the sticky per-session latch that swaps the tier>=2 distillation catalog
// for a standing notice while the chain is persistently dead. Leaf module by
// design (no src imports) so display surfaces and prepare lanes can take it
// without import-graph cycles.

/** Failure classes — the taxonomy the tool-result diagnostic must distinguish (#3638). */
export type ExternalSummaryFailureClass =
    | "candidate_unavailable"   // credential/config did not resolve at plan build; placeholder candidate
    | "input_budget_overflow"   // system+payload(+minimal reference)+output exceeds the target window; nothing sent
    | "provider_rejected"       // upstream answered non-2xx
    | "network_error"           // transport failed before a response arrived
    | "timeout"                 // per-target or shared batch deadline expired
    | "invalid_output"          // response arrived but is unusable (no summary / bad frame / tool calls / not completed)
    | "output_budget_overflow"  // response exceeds its byte budget or the summary size limits
    | "unknown_error";          // anything else — sanitized generic message

export interface ExternalSummaryFailure {
    readonly cls: ExternalSummaryFailureClass;
    /** Bounded, sanitized detail line (no URLs, keys, or response bodies). */
    readonly detail?: string;
}

/** Typed throw so the executor can classify without string matching on our own
 *  error text; unknown errors are classified defensively by classifyError. */
export class ExternalSummaryError extends Error {
    constructor(readonly failure: ExternalSummaryFailure) {
        super(failure.detail ?? failure.cls);
        this.name = "ExternalSummaryError";
    }
}

const DETAIL_MAX_CHARS = 160;

function sanitizeDetail(value: string): string {
    const scrubbed = value.replace(/https?:\/\/\S+/g, "(url)").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!scrubbed) return "";
    return scrubbed.length > DETAIL_MAX_CHARS ? `${scrubbed.slice(0, DETAIL_MAX_CHARS - 1)}…` : scrubbed;
}

function failure(cls: ExternalSummaryFailureClass, detail?: string): ExternalSummaryFailure {
    const clean = detail === undefined ? undefined : sanitizeDetail(detail);
    return clean ? { cls, detail: clean } : { cls };
}

const NETWORK_CODE_LABELS: Record<string, string> = {
    ECONNREFUSED: "connection refused",
    ECONNRESET: "connection reset",
    ETIMEDOUT: "timed out",
    ENOTFOUND: "name resolution failed",
    EAI_AGAIN: "name resolution failed",
    EHOSTUNREACH: "host unreachable",
    ENETUNREACH: "network unreachable",
    EPIPE: "connection closed early",
};

// Generic names every V8 throw carries — they carry no diagnostic content, so
// the walk keeps descending through .cause looking for the real transport
// code/name instead of stopping at "TypeError".
const GENERIC_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "DOMException", "AbortError"]);

/** Walk undici's cause chain for a structured code/name; raw messages are
 *  never echoed (they embed URLs). Returns undefined when nothing structured
 *  survives. */
function transportCode(error: unknown): string | undefined {
    let current: unknown = error;
    let deepestName: string | undefined;
    for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
        const record = current as Record<string, unknown>;
        const code = record["code"];
        if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,48}$/.test(code)) return code;
        const name = record["name"];
        if (typeof name === "string" && !GENERIC_ERROR_NAMES.has(name)) deepestName = name;
        current = record["cause"];
    }
    return deepestName;
}

/** Classify ANY thrown value into a bounded, secret-free failure. Own typed
 *  errors pass through; known legacy messages map to their class with FIXED
 *  detail strings; transport errors reduce to a code label. Raw thrown text is
 *  NEVER echoed into the result — results flow into tool output and logs, and
 *  provider errors can embed request fragments or credentials (the executor's
 *  historical "no leaked provider errors" contract). The raw message stays
 *  available for operator logging at the dispatch layer. */
export function classifyError(error: unknown): ExternalSummaryFailure {
    if (error instanceof ExternalSummaryError) return error.failure;
    const message = error instanceof Error ? error.message : String(error ?? "unknown error");
    if (/external summary candidate unavailable/i.test(message)) return failure("candidate_unavailable", "candidate could not be constructed");
    if (/exceeds the target context budget/i.test(message)) return failure("input_budget_overflow", "payload exceeds the target context budget");
    if (/upstream rejected/i.test(message)) return failure("provider_rejected", "upstream rejected the request");
    if (/byte budget|response is empty/i.test(message)) return failure("output_budget_overflow", "response exceeded its byte budget or was empty");
    if (/did not complete|invalid frame|contains no summary/i.test(message)) return failure("invalid_output", "response did not complete or contains no summary");
    const code = transportCode(error);
    if (code !== undefined || /fetch failed|network|timeout|aborted/i.test(message)) {
        return failure("network_error", code !== undefined ? (NETWORK_CODE_LABELS[code] ?? code) : "transport error");
    }
    return failure("unknown_error");
}

/** One per-batch outcome as seen by a session-scoped consumer. */
export interface ExternalBatchOutcome {
    readonly successes: number;
    readonly total: number;
    readonly classes: ExternalSummaryFailureClass[];
    /** Chain identity at dispatch time — a changed fingerprint means the
     *  previous streak was against a different configuration. */
    readonly fingerprint: string;
    /** False when the shared pool dropped the whole batch before any
     *  candidate dispatched (#2662): scheduler congestion, transient by
     *  nature — it neither arms nor clears the latch. */
    readonly dispatched: boolean;
}

const LATCH_STREAK_KEY = "externalSummaryFailStreak";
const LATCH_CLASS_KEY = "externalSummaryFailClasses";
const LATCH_FINGERPRINT_KEY = "externalSummaryFailFingerprint";

/** Consecutive all-candidate-failed batches before the tier>=2 distillation
 *  nudge is replaced by the standing notice. Two strikes: one fully-failed
 *  batch can be a transient blip; two across turns is persistence. */
const EXTERNAL_FAIL_LATCH_THRESHOLD = 2;

/** Stable identity of an enabled external-summary chain — enough to tell
 *  "the user fixed the same chain" (fingerprint unchanged) from "a different
 *  chain now serves this session" (fingerprint changed → fresh streak).
 *  Credential VALUES are deliberately excluded (presence only); the endpoint
 *  URL is config, not a secret, and lives only in local session metadata. */
export function externalSummaryFingerprint(settings: unknown): string {
    const chain = settings as { enabled?: unknown; targets?: unknown; budget?: unknown } | null | undefined;
    if (!chain || typeof chain !== "object" || chain.enabled !== true) return "off";
    const targets = Array.isArray(chain.targets) ? chain.targets : [];
    const parts = targets.map((value) => {
        const t = value as Record<string, unknown> | null;
        if (!t || typeof t !== "object") return "?";
        return [t["name"], t["protocol"], t["url"], t["model"], t["contextWindow"], t["outputTokens"], t["credentialRef"] !== undefined ? "ref" : "inline", t["stream"]].join("/");
    });
    const budget = (chain.budget ?? {}) as Record<string, unknown>;
    return `${parts.join(";")}#${budget["totalTimeoutMs"]}:${budget["targetTimeoutMs"]}:${budget["maxSummaryBytes"]}`;
}

/** Sticky per-session latch over session.metadata (same discipline as
 *  autoFoldBackoffUntil / nudgeDecideFails). Success clears; a changed chain
 *  fingerprint restarts the streak at one; congestion-only batches are
 *  ignored entirely. */
export function recordExternalBatchOutcome(metadata: Record<string, unknown>, outcome: ExternalBatchOutcome): void {
    if (outcome.total === 0) return;
    if (outcome.successes > 0) {
        delete metadata[LATCH_STREAK_KEY];
        delete metadata[LATCH_CLASS_KEY];
        delete metadata[LATCH_FINGERPRINT_KEY];
        return;
    }
    if (!outcome.dispatched && outcome.classes.length === 0) return;
    const previousFingerprint = metadata[LATCH_FINGERPRINT_KEY];
    const previousStreak = typeof metadata[LATCH_STREAK_KEY] === "number" ? (metadata[LATCH_STREAK_KEY] as number) : 0;
    metadata[LATCH_STREAK_KEY] = previousFingerprint === outcome.fingerprint ? previousStreak + 1 : 1;
    const merged = new Set<string>();
    const previous = metadata[LATCH_CLASS_KEY];
    if (Array.isArray(previous)) for (const entry of previous) if (typeof entry === "string") merged.add(entry);
    for (const cls of outcome.classes) merged.add(cls);
    metadata[LATCH_CLASS_KEY] = [...merged].slice(0, 4);
    metadata[LATCH_FINGERPRINT_KEY] = outcome.fingerprint;
}

export function externalFailureLatchActive(metadata: Record<string, unknown> | undefined, fingerprintNow: string): boolean {
    if (!metadata) return false;
    const streak = metadata[LATCH_STREAK_KEY];
    return typeof streak === "number" && streak >= EXTERNAL_FAIL_LATCH_THRESHOLD
        && metadata[LATCH_FINGERPRINT_KEY] === fingerprintNow;
}

export function externalFailureClasses(metadata: Record<string, unknown> | undefined): string[] {
    const value = metadata?.[LATCH_CLASS_KEY];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function externalFailureStreak(metadata: Record<string, unknown> | undefined): number {
    const value = metadata?.[LATCH_STREAK_KEY];
    return typeof value === "number" ? value : 0;
}

/** The concise standing replacement for the full tier>=2 block catalog while
 *  the latch is armed: what is wrong (class), what is safe (nothing committed),
 *  and the actionable recovery path. Bounded by construction — no catalog. */
export function renderExternalFailureNotice(tier: number, classes: readonly string[], streak: number): string {
    const kind = tier === 3 ? "CONDENSATION" : "DISTILLATION";
    const classList = classes.length > 0 ? classes.slice(0, 3).join(", ") : "unknown_error";
    return [
        `[EXTERNAL SUMMARY UNAVAILABLE — TIER ${tier} ${kind} PAUSED]`,
        `The configured independent summary service has failed ${streak} consecutive batch(es) (last reason(s): ${classList}). Nothing was compressed: no fold was committed and all originals are intact.`,
        "Recovery: fix the external summary configuration (credentials, targets, or context/output windows — see the bili panel) or set compress.externalSummary.enabled=false to restore model-written summaries. Tier distillation resumes automatically after the first successful fold.",
    ].join("\n");
}
