// #1206: per-session compression-conflict ledger. Every piece of evidence that
// another compressor (third-party plugin, client native compaction) touched
// this conversation lands here so the user can SEE it (acp_status / web UI /
// stats) instead of finding out later from scrambled context. Bounded ring —
// the ledger is diagnostic, not history.
// #2102: lifecycle — the display layer must treat it as diagnostic: events are
// split ACTIVE (within CONFLICT_ACTIVE_WINDOW_MS) vs historical so a months-old
// stock ledger no longer reads as a live alarm, and the whole ledger can be
// wiped via clearConflictEvents (POST /__bili/conflicts/clear). Wiping loses
// no conversation data — only the evidence notes.

import { markDirty, type Session } from "./session.js";
import { isCodexClient } from "./codex-compact.js";
import { isDisplayOnlyConflictDetail, isSiblingConflictDetail } from "./thirdparty-scan.js";

type ConflictKind = "third-party-plugin" | "unannounced-rewrite" | "orphan-reap" | "native-compaction" | "native-compaction-inferred" | "identity-orphan" | "id-churn-adoption";

export interface ConflictEvent {
    at: number;
    kind: ConflictKind;
    detail: string;
}

export const CONFLICT_LEDGER_MAX = 20;

/** #2102: events newer than this count as ACTIVE (live double-compression
 *  risk); older ones are historical stock. Internal constant — deliberately
 *  NOT a config knob (config surface is owner-gated). The 7-day yardstick
 *  matches BILI_SESSION_GC_MAX_AGE_DAYS so "stale" means the same thing
 *  everywhere in bili. */
export const CONFLICT_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function splitConflictEvents(events: ConflictEvent[], now: number = Date.now()): { active: ConflictEvent[]; historical: ConflictEvent[] } {
    const active: ConflictEvent[] = [];
    const historical: ConflictEvent[] = [];
    for (const e of events) (now - e.at <= CONFLICT_ACTIVE_WINDOW_MS ? active : historical).push(e);
    return { active, historical };
}

export function conflictEventsOf(session: Session): ConflictEvent[] {
    const raw = session.metadata.conflictEvents;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is ConflictEvent =>
        !!e && typeof e === "object" &&
        typeof (e as ConflictEvent).at === "number" &&
        typeof (e as ConflictEvent).kind === "string" &&
        typeof (e as ConflictEvent).detail === "string",
    );
}

export function recordConflict(session: Session, kind: ConflictKind, detail: string): void {
    const events = conflictEventsOf(session);
    events.push({ at: Date.now(), kind, detail });
    while (events.length > CONFLICT_LEDGER_MAX) events.shift();
    session.metadata.conflictEvents = events;
    markDirty(session);
}

// #2709: a framing-absent host-native compaction landing leaves no checkpoint
// marker for carriesDshLocalCompactionSummary to catch, so the #1001/#2193
// detectors classify it as a generic unannounced rewrite and the banner sends
// the user hunting for a phantom second compressor. bili already WITNESSES such
// landings indirectly: while the client kept calling bili's proxy for compaction,
// bili refused those calls (#1729/#2028) and counted them in
// metadata.dshCompactionRefusals (src/server/handle.ts). A dsh-bound session with a
// non-zero refusal count plus a detected bulk rewrite is therefore attributable to
// client-native compaction — not a foreign plugin — even without the marker.
// Attribution ONLY: without the marker bili cannot identify the checkpoint, so it
// must NOT rebase onto a guessed view (rebase stays gated on the framed detector).
// Returns the refusal count when the inference holds, else undefined (caller keeps
// the existing unannounced-rewrite classification).
//
// #3814 (via #3806): the refusal counter alone is NOT enough — it persists for the
// session's life (often accumulated days ago under an older bili), and a dsh
// RESTART re-keys ~all resent message ids, which trips the same #1001 rewrite
// detector without anything having been compacted. The discriminator is the
// compaction fingerprint: a landed client compaction folds the replayed region
// into one summary, so the first replay after it carries only the recent tail —
// #2709's real landings measured 320/771 (41%) and 427/875 (49%) incoming/known;
// #3806's restart re-keys measured 2793/2814 (99%) and 395/389 (101%, it GREW).
// Callers that have the rewrite evidence MUST pass it: a flat-or-larger resend
// (incoming >= 75% of known) is a re-key, not a landing, and must keep the quiet
// unannounced-rewrite tier even with a non-zero stale refusal counter.
const DSH_COMPACTION_LANDING_MAX_INCOMING_RATIO = 0.75;

interface RewriteFingerprint {
    incomingTotal: number;
    knownBefore: number;
}

export function dshNativeCompactionWitness(session: Session, fingerprint?: RewriteFingerprint): number | undefined {
    const md = session.metadata;
    if (!md || md.pluginAgent !== "dsh") return undefined;
    const n = md["dshCompactionRefusals"];
    if (typeof n !== "number" || n <= 0) return undefined;
    if (fingerprint && fingerprint.knownBefore > 0
        && fingerprint.incomingTotal >= fingerprint.knownBefore * DSH_COMPACTION_LANDING_MAX_INCOMING_RATIO) {
        return undefined;
    }
    return n;
}

// #2219: resolve which CLIENT a conflicting session belongs to, so the conflict
// surfaces (acp_status / web banner / launcher) can show per-client remediation
// instead of stopping at the bare imperative "keep exactly one compressor".
// Identity is already recorded at request time (#1426): pluginAgent wins when
// present ("mcp" is not a client name — MCP evidence flip, #760b — so fall
// through), then clientHint, which is either an exact sniffScanClient value or
// a UA truncation; codex UA shapes normalize back to "codex" and clean single
// tokens pass through as-is (unknown ones simply get the generic hint).
export function conflictClientOf(session: Session): string | undefined {
    const pa = session.metadata.pluginAgent;
    if (typeof pa === "string" && pa.length > 0 && pa !== "mcp") return pa;
    const hint = session.metadata.clientHint;
    if (typeof hint !== "string" || !hint) return undefined;
    if (/^[a-z][a-z0-9-]*$/.test(hint)) return hint;
    if (isCodexClient({ "user-agent": hint })) return "codex";
    return undefined;
}

/** #2219: where the full client×mechanism matrix lives — every hint surface
 *  points here instead of duplicating the matrix. */
export const CONFLICT_DOCS_POINTER = 'CONFIGURATION.md → "Detecting other compression plugins (#1206)"';

// #2219: one-line per-client remediation for the conflict surfaces. Each entry
// mirrors its doc anchor (README opencode section / CONFIGURATION.md claude
// auto-compact alignment + BILI_CODEX_COMPACT / pi·omp carriage evidence
// #851/#1382); keep each entry ONE line — these render inline in acp_status
// text, the web banner, and launcher stderr.
export function conflictRemediation(client: string | undefined): string {
    switch (client) {
        case "opencode":
            return 'set "compaction": { "auto": false } in your opencode config (or use bili opencode / bili plugin install opencode, which set it for you)';
        case "claude":
            return "launch through bili claude (it aligns CLAUDE_CODE_AUTO_COMPACT_WINDOW automatically), or set CLAUDE_CODE_AUTO_COMPACT_WINDOW to bili's effective window yourself";
        case "codex":
            return "BILI_CODEX_COMPACT=intercept by default: bili intercepts codex compaction in every form — explicit (/compact, /responses/compact, compaction_trigger) and the inline auto-compact that transits as an ordinary turn detected by its SUMMARIZATION_PROMPT template (#3008) — if you set pass, remove the override; a compaction bili merely observed (pass/gate) is rebased post-hoc (#2372)";
        case "pi":
        case "omp":
            return "the bili extension cancels the client's native auto-compaction while it carries the conversation — seeing this suggests missing carriage evidence or an old version; report client + bili version";
        default:
            return "disable the client's own auto-compaction (or route this session around bili), then start a fresh session — the ledger is per-session, so old entries clear with the old session";
    }
}

function fmtTime(at: number): string {
    return new Date(at).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function isSuspectedEvent(e: ConflictEvent): boolean {
    return e.kind === "third-party-plugin" && e.detail.endsWith("[suspected]");
}

// #2545: evidence tiers. NEUTRAL = records naming things that are NOT second
// compressors by verification: bili's own siblings (stand down while bili drives
// the session, #2261) and verified non-compressing plugins (#2324/#2545/#2969).
// CONFIRMED = bili identified who rewrote the conversation: a detected
// native-compaction landing, or a plugin finding that is not name-only
// [suspected]. UNCONFIRMED SIGNALS = observations consistent with external
// rewriting whose CAUSE is not identified: unannounced rewrites (ref coverage
// dropped) and orphan reaps (summarized content left the client history).
// Severity surfaces must grade by tier — cross-session aggregate counts of
// unconfirmed signals are NOT evidence of same-conversation double compression.
function isNeutralEvent(e: ConflictEvent): boolean {
    return e.kind === "third-party-plugin" && (isSiblingConflictDetail(e.detail) || isDisplayOnlyConflictDetail(e.detail));
}

function isConfirmedConflictEvent(e: ConflictEvent): boolean {
    // #2709: an attributed (inferred) native-compaction landing is confirmed enough to
    // stop the "hunt for a second compressor" errand — bili saw no checkpoint marker, so
    // it could NOT rebuild the fold base; that residual risk keeps it in the confirmed tier.
    // #2912: a MARKER-detected landing (`native-compaction`) is by construction already
    // rebased onto (#2372/#2432 — every record site marks then reconciles back-to-back),
    // i.e. handled with no ongoing corruption risk, so it no longer counts as confirmed
    // evidence. Warned-on-impact policy (#2912): a fully-handled ledger must not alarm.
    if (e.kind === "native-compaction-inferred") return true;
    if (e.kind !== "third-party-plugin") return false;
    return !isNeutralEvent(e) && !isSuspectedEvent(e);
}

export function formatConflictSection(events: ConflictEvent[], now: number = Date.now(), client?: string): string[] {
    const lines: string[] = [];
    // #2102: label the age split up front — an all-historical section must not
    // read as a live alarm (it previously said "two compressors ..." imperatively
    // even when every event was months old).
    const { active, historical } = splitConflictEvents(events, now);
    // #2545: tier the ledger BEFORE choosing framing — the double-compression
    // claim in the header is only made when confirmed evidence is present.
    const meaningful = events.filter((e) => !isNeutralEvent(e));
    const confirmed = meaningful.filter(isConfirmedConflictEvent);
    const foreignConfirmed = confirmed.some((e) => e.kind === "third-party-plugin");
    // #2709/#2912: only an attribution-only (inferred) landing reaches the confirmed tier —
    // a marker-detected landing (`native-compaction`) is already rebased onto (#2372/#2432)
    // and is instead handled by the dedicated handledNativeOnly branch below.
    const nativePresent = confirmed.some((e) => e.kind === "native-compaction-inferred");
    const signals = meaningful.filter((e) => e.kind === "unannounced-rewrite" || e.kind === "orphan-reap");
    // #2802 review: identity-orphan-only ledgers are bili's own confirmed
    // diagnostic (host lane lost its identity stamp — #2791 family), not a
    // second-compressor hunt; the plugin-hunt tiers below would misframe them.
    // Gated to orphan-only so mixed ledgers keep their existing tier verbatim.
    const orphanOnly = meaningful.length > 0 && meaningful.every((e) => e.kind === "identity-orphan");
    // #2912: a ledger whose every meaningful event is a marker-detected native-compaction
    // landing was fully rebased onto (#2372/#2432) — handled, no ongoing risk. Gated to the
    // pure case so mixed ledgers keep their existing tier verbatim.
    const handledNativeOnly = meaningful.length > 0 && meaningful.every((e) => e.kind === "native-compaction");
    const activeConfirmed = confirmed.some((e) => now - e.at <= CONFLICT_ACTIVE_WINDOW_MS);
    lines.push(`COMPRESSION CONFLICTS — ${events.length} event(s) in this session (${active.length} active · ${historical.length} historical; active = within ${CONFLICT_ACTIVE_WINDOW_MS / 86_400_000} days). ${foreignConfirmed || nativePresent
        ? "Two compressors on one conversation (bili + another compression plugin — third-party or bili's own sibling — or client native compaction) double-compress and corrupt message refs:"
        : "Diagnostic evidence that something outside bili touched this conversation — how strong that evidence is is tiered below:"}`);
    for (const e of events.slice(-10)) {
        lines.push(`  [${fmtTime(e.at)}] ${e.kind} — ${e.detail}`);
    }
    if (events.length > 10) lines.push(`  … ${events.length - 10} earlier event(s); full list: the conflicts field of GET /__bili/stats`);
    // #1736: the [suspected] tier is a name-only guess, not observed evidence —
    // say so, and don't command removal when nothing confirmed was found.
    const suspectedCount = events.filter(isSuspectedEvent).length;
    if (suspectedCount > 0) {
        lines.push("  [suspected] = name-only keyword match — verify the plugin actually compresses before acting; a context dashboard/viewer/tool is NOT a compressor.");
    }
    // #2545 branch ladder, first match wins:
    //   neutral-only             -> stand-down: siblings + verified read-only viewers
    //   foreign confirmed        -> strong one-compressor command (live) or verify-then-clear (stock)
    //   native landing (no foreign)-> host-side explanation, no plugin hunt (#2432)
    //   identity-orphan only     -> host-lane identity loss, no second compressor (#2802 review)
    //   pure [suspected]         -> #1736 soft wording
    //   unconfirmed signals      -> "cause not identified" framing, never imperative
    let advice: string;
    if (meaningful.length === 0) {
        advice = "Every event above names bili's OWN sibling extension (billion-context-pi / opencode-acp) or a verified non-compressing plugin (a read-only viewer/tool, or a protocol adapter whose name merely collides with a compression keyword — e.g. 'acp' meaning Agent Client Protocol): while bili drives the session the sibling stands down automatically (BILLION_CONTEXT_NATIVE marker in native mode, /bili/ baseUrl self-check otherwise) and the verified plugin does not compress anything, so no second compressor is active. Verify your bili/sibling versions are recent, then clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear.";
    } else if (foreignConfirmed) {
        advice = activeConfirmed
            ? "Keep exactly ONE compressor per conversation: remove/disable the other plugin (or its native auto-compaction), then start a fresh session."
            : "The confirmed event(s) above are older than 7 days (historical stock): the double-compression risk may no longer be live. Verify the other compression plugin is removed or blocked by bili, then clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear?session=<id>.";
    } else if (nativePresent) {
        // #2432: a ledger pointing at the client's OWN native compaction landing is
        // not "a second compressor fighting you" — commanding the model to hunt for
        // and disable another plugin sends it on a useless errand (the incident
        // model did exactly that). Only foreign CONFIRMED third-party events keep
        // the one-compressor command; suspected names never do (#1736 tiering).
        // #2709: an INFERRED landing has no checkpoint marker, so bili could NOT
        // rebuild the fold base — say that precisely instead of promising a rebuild.
        advice = "The events above point at the client's OWN native compaction landing (host-side), not a third-party plugin — do not go hunting for a second plugin to disable. bili attributed this from its own witness (it refused the client's compaction calls this session) but did NOT see the checkpoint marker, so it could not rebuild the fold base onto the compacted view — this session's fold base is gone; start a fresh conversation.";
    } else if (handledNativeOnly) {
        // #2912: every event here is a marker-detected native-compaction landing that bili
        // already rebased onto (#2372/#2432) — handled at the time, no ongoing risk. Say so
        // plainly rather than misframing it under the [suspected]/unconfirmed tiers.
        advice = active.length > 0
            ? "The events above are client-native compaction landings bili ALREADY rebased onto (#2372/#2432): each detected checkpoint rebuilt the fold base, so there is no ongoing double-compression risk and nothing to disable. If you did not expect these sessions to auto-compact, review the client's own auto-compaction setting; otherwise clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear?session=<id>."
            : "All events above are client-native compaction landings older than 7 days (historical stock) that bili already rebased onto (#2372/#2432): handled at the time, no ongoing risk. Clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear?session=<id>.";
    } else if (orphanOnly) {
        // A headerless replay does not prove that the original client moved.
        // Older ledgers may contain tail-only matches; neither proves state loss.
        advice = active.length > 0
            ? "The events above are possible identity-loss replays (#2791 family): an anonymous request shared history with an identified conversation. This does NOT prove that the original client stopped sending its id or that fold continuity was lost; older tail-only matches can also come from unrelated auxiliary requests. Original session state is retained. Verify whether subsequent main requests still use the original conversation id. There is NO second compressor to hunt for and no auto-compaction to disable."
            : "All events above are possible identity-loss replays older than 7 days (historical stock), not proof of continuity loss. Older tail-only matches may be unrelated auxiliary requests. Verify the client's main requests still use their conversation id, then clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear?session=<id>.";
    } else if (signals.length === 0) {
        advice = active.length > 0
            ? "Every event above is [suspected]: confirm each named plugin really compresses before removing anything — do not drop a read-only tool on the strength of its name."
            : "Every event above is [suspected] AND older than 7 days (historical stock): confirm each named plugin really compresses before removing anything — do not drop a read-only tool on the strength of its name. If none of them turns out to compress, clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear?session=<id>.";
    } else {
        advice = active.length > 0
            ? "Every event above is an UNCONFIRMED signal: history changes were observed (rewrites without a recognized compaction marker, summarized blocks leaving the client history) and/or name-only [suspected] plugin matches, but nothing here identifies WHO rewrote the conversation — the cause is not confirmed. Do not drop a read-only tool or viewer on the strength of these records; verify the named plugins and the client's auto-compaction settings before acting."
            : "All events above are UNCONFIRMED signals older than 7 days (historical stock): history changes were observed but their cause was never identified, and no second compressor is confirmed. If the affected sessions are gone, clear this ledger — Web UI conflict banner / session page, or POST /__bili/conflicts/clear?session=<id>.";
    }
    lines.push(advice);
    // #2219: actionable per-client remediation — the surfaces used to stop at
    // WHAT happened; answering HOW required digging out four separate doc
    // locations, none linked from any conflict surface. Skipped for the #2261
    // neutral-only ledger: its footer already says no second compressor is
    // active, so a per-client fix command would contradict it. Also skipped
    // for #2802-review orphan-only ledgers: their advice names the real fix
    // (restore the identity-stamping lane) — a generic auto-compaction command
    // would contradict it too. And skipped for PURE [suspected] ledgers (#2969):
    // every event is an unverified name match, so the default command ("disable
    // the client's own auto-compaction ... start a fresh session") demands
    // corrective action although nothing was confirmed — the verify-first advice
    // above already covers what to do. Confirmed, unconfirmed-signal, and MIXED
    // ledgers (incl. orphan+suspected, kept verbatim by the #2802-review gate)
    // keep the footer.
    const pureSuspectedTier = meaningful.length > 0 && confirmed.length === 0 && signals.length === 0
        && !meaningful.some((e) => e.kind === "identity-orphan");
    if (meaningful.length > 0 && !orphanOnly && !pureSuspectedTier) {
        lines.push("", `Fix${client ? ` (${client})` : ""}: ${conflictRemediation(client)}`);
        lines.push(CONFLICT_DOCS_POINTER);
    }
    return lines;
}

interface ConflictSummary {
    sessions: number;
    events: number;
    /** #2102: events within CONFLICT_ACTIVE_WINDOW_MS of `now` (live risk). */
    active: number;
    /** #2102: events older than the window (historical stock). */
    historical: number;
    /** #2102: timestamp of the newest event across all sessions, or null. */
    lastAt: number | null;
    kinds: Partial<Record<ConflictKind, number>>;
    /** #2261: plugin-kind events naming bili's OWN siblings (billion-context-pi /
     *  opencode-acp) — display-time classification of recorded details, additive
     *  to `kinds`, so surfaces can stop calling first-party siblings "third-party". */
    sibling: number;
    /** #2324: name-only [suspected] plugin events — a subset of kinds["third-party-plugin"],
     *  additive, so display surfaces can stop treating unverified name matches as
     *  confirmed compressors. Disjoint from `sibling` (siblings are never suspected). */
    suspected: number;
    /** #2545: plugin-kind events naming VERIFIED read-only (display-only) plugins —
     *  display-time classification of recorded details (stock ledgers written by pre-#1736
     *  keyword rules carry them as [suspected]). Additive within kinds["third-party-plugin"],
     *  disjoint from `sibling`, and OVERLAPPING `suspected` for those stock records — display
     *  surfaces subtract it BEFORE suspected so the records count for no severity. */
    displayOnly: number;
    /** #2545: CONFIRMED-tier events (isConfirmedConflictEvent) within the active window —
     *  liveness of the confirmed evidence itself, so a fresh unconfirmed signal cannot
     *  re-light a stale confirmed ledger as a live alarm. Subset of `active`. */
    activeConfirmed: number;
    latest: Array<{ sessionId: string; at: number; kind: ConflictKind; detail: string }>;
    /** #2219: distinct resolved clients of sessions carrying events (first-seen
     *  order) — lets the web banner show per-client remediation hints. */
    clients: string[];
}

export function summarizeConflicts(sessions: Session[], now: number = Date.now()): ConflictSummary {
    const summary: ConflictSummary = { sessions: 0, events: 0, active: 0, historical: 0, lastAt: null, kinds: {}, latest: [], sibling: 0, suspected: 0, displayOnly: 0, activeConfirmed: 0, clients: [] };
    for (const s of sessions) {
        const events = conflictEventsOf(s);
        if (events.length === 0) continue;
        summary.sessions += 1;
        summary.events += events.length;
        const c = conflictClientOf(s);
        if (c && !summary.clients.includes(c)) summary.clients.push(c);
        for (const e of events) {
            summary.kinds[e.kind] = (summary.kinds[e.kind] ?? 0) + 1;
            if (e.kind === "third-party-plugin" && isSiblingConflictDetail(e.detail)) summary.sibling += 1;
            if (e.kind === "third-party-plugin" && isDisplayOnlyConflictDetail(e.detail)) summary.displayOnly += 1;
            if (isSuspectedEvent(e)) summary.suspected += 1;
            const isActive = now - e.at <= CONFLICT_ACTIVE_WINDOW_MS;
            if (isActive) summary.active += 1; else summary.historical += 1;
            if (isActive && isConfirmedConflictEvent(e)) summary.activeConfirmed += 1;
            if (summary.lastAt === null || e.at > summary.lastAt) summary.lastAt = e.at;
        }
        const last = events[events.length - 1]!;
        summary.latest.push({ sessionId: s.id, at: last.at, kind: last.kind, detail: last.detail });
    }
    summary.latest.sort((a, b) => b.at - a.at);
    return summary;
}

/** #2102: wipe diagnostic ledgers — globally, or one session by id. Wiping is
 *  safe by design (#1206: "diagnostic, not history") and loses no conversation
 *  data. Returns how much was actually cleared. */
export function clearConflictEvents(sessions: Session[], sessionId?: string): { events: number; sessions: number } {
    let events = 0;
    let clearedSessions = 0;
    for (const s of sessions) {
        if (sessionId !== undefined && s.id !== sessionId) continue;
        const raw = conflictEventsOf(s);
        if (raw.length === 0) continue;
        delete s.metadata.conflictEvents;
        markDirty(s);
        events += raw.length;
        clearedSessions += 1;
    }
    return { events, sessions: clearedSessions };
}
