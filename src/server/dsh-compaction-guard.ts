/**
 * #1729: dsh native compaction-call guard.
 *
 * dsh's `dsh-compaction-basic` answers context pressure by replaying the whole
 * conversation prefix and appending a fixed summarization directive
 * (COMPACTION_INSTRUCTION, dsh-compaction-basic/lib/index.js) as the FINAL
 * user message, reusing the same session id so the provider's KV prefix cache
 * stays warm. In the desktop lane those calls ride bili under the main
 * conversation id — the second producer of #1729's deadlock — and when one
 * LANDS, dsh durably shadows the replayed surface range: the original
 * messages never ride a future request again, which destroys the proxy's
 * compression substrate (irreversible, unlike every cost of refusing).
 *
 * This guard identifies the call at the traffic level and refuses it locally:
 * never forwarded, kernel state untouched. MARKER-DECISIVE (#2193): the final
 * user message STARTS with the versioned instruction prefix (machine-appended
 * by the summarizer, never user-chosen in practice) and that is sufficient on
 * its own. The original two-signal AND carried a SHAPE bar (≤4 messages,
 * pinned to rc.1-era observations — 2 msgs at ~152K tokens in the #1727/#1729
 * logs); dsh-compaction-basic 0.2.0-rc.2 changed the summarize call to replay
 * the ENTIRE shadowed region as the message prefix (~1100+ messages), which
 * made SHAPE permanently false and the whole guard silently pass through — a
 * landed checkpoint then durably shadowed the raw history of a live session
 * (#2193). The failure direction of an extra shape signal is exactly what
 * hurt: silent pass of an irreversible call. The cost asymmetry decides: one
 * pass-through = permanent substrate loss, one refusal = dsh falls back to
 * bili-owned compression (auto pressure, overflow recovery, and manual /compact
 * all send the same envelope and all recover). A fully reworded template
 * degrades to a miss (today's pre-#1729 behavior) — inherent to text matching;
 * the tracked sentence is refreshed per dsh release like MAIN_SYSTEM_PREFIXES
 * tracks Claude Code's system prompts (#970).
 *
 * PROTOCOL COVERAGE (#2360): the whitelist used to read openai/anthropic ONLY.
 * dsh's desktop lane speaks Responses (/v1/responses, /responses/compact), so
 * every compaction call on that wire hit the protocol check and returned
 * false BEFORE the marker was ever examined — the second AND-condition
 * failure after #2193's SHAPE fix (marker-decisive but protocol-blind, and
 * the pass-through stayed completely silent: no warn, no refusal, the exact
 * failure direction #2193 eliminated). All three lanes are now marker-
 * decisive with the same final-user-message rule; each wire contributes its
 * last role=user text (messages[] for openai/anthropic, input[] for
 * responses). Google's contents/parts shape stays out of scope — dsh speaks
 * no Google wire.
 *
 * Deliberately unconditional (auto pressure, context-overflow recovery, and
 * manual /compact all send the same envelope — the traffic layer cannot tell
 * which trigger fired, and a landed checkpoint is equally destructive from
 * any of them). Not gated on the dsh plugin marker: a dsh host routed through
 * a global bili proxy without the plugin bundle must be covered too. Refusal
 * message text intentionally rides into dsh's own warn line
 * ("step compaction failed: <message>; continuing the turn").
 */

import { createHash } from "node:crypto";

/** Stable opening sentence of dsh's COMPACTION_INSTRUCTION template
 * (verbatim from @deepseek-ai/dsh-compaction-basic, tracked per dsh release
 * like MAIN_SYSTEM_PREFIXES tracks Claude Code's system prompts, #970). */
export const DSH_COMPACTION_INSTRUCTION_PREFIX =
    "You are now acting as a compaction engine for this AI coding assistant";

/** rc.1-era envelope size of the compaction call (replayed prefix collapsed +
 * directive; observed as 2 msgs at ~152K tokens in the #1727/#1729 logs).
 * Retained ONLY to flag shape drift in the refusal warn when a newer dsh
 * release replays the full shadowed region (~1100+ msgs, #2193) — NEVER used
 * for gating: that bar made the guard permanently blind on rc.2 while its
 * pass-through stayed silent. */
export const DSH_COMPACTION_SHAPE_MSGS = 4;

type Rec = Record<string, unknown>;

/** Concatenate a wire content field (string | parts array) into plain text. */
function textOfContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let out = "";
    for (const part of content) {
        if (typeof part === "string") out += part;
        else if (part !== null && typeof part === "object" && typeof (part as Rec).text === "string") {
            out += (part as Rec).text;
        }
    }
    return out;
}

/** Text of the LAST role=user message for the messages-shaped protocols
 * (openai chat/completions, anthropic messages). Google's contents/parts
 * shape stays out of scope — dsh speaks no Google wire. */
function lastUserMessageText(protocol: string, parsed: unknown): string | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const messages = (parsed as Rec).messages;
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m === null || typeof m !== "object") continue;
        if ((m as Rec).role !== "user") continue;
        return textOfContent((m as Rec).content);
    }
    return undefined;
}

/** Text of the LAST role=user item on the Responses wire (parsed.input).
 * Items are typed objects ({type:"message", role, content: string | parts[]});
 * function_call / function_call_output / reasoning items never carry user
 * prose, so a role check plus the type guard is enough (#2360). */
function lastResponsesInputUserText(parsed: unknown): string | undefined {
    if (parsed === null || typeof parsed !== "object") return undefined;
    const input = (parsed as Rec).input;
    if (!Array.isArray(input)) return undefined;
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (item === null || typeof item !== "object") continue;
        const rec = item as Rec;
        if (rec.role !== "user") continue;
        if (rec.type !== undefined && rec.type !== "message") continue;
        return textOfContent(rec.content);
    }
    return undefined;
}

/** Marker-decisive test (#2193): the final user message starts with the
 * versioned instruction prefix. Message count plays NO part — rc.2 replays
 * the full shadowed region (~1100+ msgs) and the old ≤4 bar made the guard
 * permanently blind while its pass-through stayed silent. Protocol coverage
 * (#2360): openai + anthropic read messages[], responses reads input[] — the
 * pre-#2360 whitelist returned false for the responses lane before the marker
 * was ever examined. */
export function isDshCompactionCall(protocol: string | null, parsed: unknown): boolean {
    let finalUser: string | undefined;
    if (protocol === "responses") finalUser = lastResponsesInputUserText(parsed);
    else if (protocol === "openai" || protocol === "anthropic") finalUser = lastUserMessageText(protocol, parsed);
    if (finalUser === undefined) return false;
    return finalUser.trimStart().startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX);
}

/** #2709: raw-ASCII sniff of the instruction marker — the first 48 bytes of
 * DSH_COMPACTION_INSTRUCTION_PREFIX. Used as a cheap prefilter on the
 * passthrough lane so ordinary background traffic (title-gen, plugin calls)
 * never pays a JSON.parse; a hit still goes through the full marker-decisive
 * check below, so a conversation that merely MENTIONS the instruction string
 * in ordinary text does not false-positive (the real check requires the final
 * user message to START with the prefix). Exported so the client-side fetch
 * patch (#2763) mirrors the EXACT same bytes instead of re-deriving the
 * length. */
export const DSH_COMPACTION_MARKER_SNIFF = DSH_COMPACTION_INSTRUCTION_PREFIX.slice(0, 48);

/** #2709 process-level count of passthrough-lane refusals (no session exists
 * on that lane, so the per-session #2490 ledger cannot record them). Exported
 * mutable record for tests and future stats surfacing. */
export const dshPassthroughGuardStats = { refusals: 0 };

/** #2709: the passthrough lane (x-bili-passthrough, #1117) relays byte-untouched
 * with "no session, no injection, no guard" — which made it the one lane dsh's
 * agentless background compaction could still LAND through: the takeover gate
 * refuses attribution for agentless callers while the settings overlay has
 * already routed the URL to /bili/, so the native patch stamps the request and
 * it relays verbatim BELOW the #1835 pipeline guard (field report: 45 refused
 * through the pipeline, 4 landed through this lane). This runs the same
 * marker-decisive detection on the passthrough body. Fail-open like #1835:
 * anything undecodable/unparseable returns false and the request relays exactly
 * as before. `decode` is supplied by the caller (bounded decode + admission
 * accounting, reusing the standard request-body budget). */
export async function detectPassthroughDshCompactionCall(
    protocol: string | null,
    bodyBuffer: Buffer,
    contentEncoding: string | undefined,
    decode: (encoding: string, body: Buffer) => Promise<Buffer>,
): Promise<boolean> {
    if (protocol === null) return false;
    let candidate: Buffer | undefined;
    if (bodyBuffer.includes(DSH_COMPACTION_MARKER_SNIFF)) {
        candidate = bodyBuffer;
    } else {
        // A declared content-encoding hides the marker from the raw sniff —
        // decode a bounded COPY (the relay below still forwards the original
        // bytes; nothing here may reassign bodyBuffer or drop the header).
        if (contentEncoding === undefined || contentEncoding === "" || contentEncoding === "identity") return false;
        let decoded: Buffer;
        try {
            decoded = await decode(contentEncoding, bodyBuffer);
        } catch {
            return false;
        }
        if (!decoded.includes(DSH_COMPACTION_MARKER_SNIFF)) return false;
        candidate = decoded;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(candidate.toString("utf8"));
    } catch {
        return false;
    }
    return isDshCompactionCall(protocol, parsed);
}

// #2432: dsh compaction-basic's CHECKPOINT FRAMING — the single replacement
// user message a LANDED compaction writes into the client's history
// (CHECKPOINT_PREAMBLE + SUMMARY_OPEN_TAG … SUMMARY_CLOSE_TAG,
// @deepseek-ai/dsh-compaction-basic 0.2.x lib/index.js). Version-pinned like
// DSH_COMPACTION_INSTRUCTION_PREFIX (#970): if these bytes drift the detector
// silently stops matching and degrades to the pre-#2432 unannounced-rewrite
// archive path — never a false positive. Angle brackets hex-escaped per KDD #2.
export const DSH_CHECKPOINT_OPEN_TAG = "\x3ccompacted-summary\x3e";
export const DSH_CHECKPOINT_PREAMBLE_PREFIX =
    "This is an automatically generated checkpoint condensing an earlier span of the conversation";

// #2432: floor on decimated fold coverage for local-compaction detection — the
// same bar as codex's CODEX_LOCAL_COMPACTION_MIN_MISSING (#2373): below it,
// missing ids are ordinary drift (edit/truncate), not a region replacement.
export const DSH_LOCAL_COMPACTION_MIN_MISSING = 8;

// #3033: bili's own render tags (`\x3cacp tokens="…" type="…"\x3emNNNNN\x3c/acp\x3e`,
// KDD #2) ride inside resent prose — a checkpoint summary cites prior refs
// ("summaries cite tags across turns", kernel contract) — and every native-
// compaction rebase RE-ISSUES those numbers, so the SAME checkpoint hashes to
// a FRESH message id on each replay: the novelty gate stays open forever, the
// detector re-fires, and each reset manufactures the next detection (the #3033
// loop: 66 detections, compress rejected 40/40, session wedged). Fingerprint
// the checkpoint CONTENT with the volatile numbering normalized away.
const ACP_RENDER_TAG_SPAN = /\x3cacp\b[^\x3e]*\x3e[\s\S]*?\x3c\/acp\x3e/g;
const ACP_RENDER_TAG_REMNANT = /\x3c\/?acp\b[^\x3e]*\x3e/g;
const ACP_RENDER_TAG_PLACEHOLDER = "\x3cacp/\x3e";

/** #3033: strip the ref-number churn out of a checkpoint text so its
 *  fingerprint identifies the COMPACTION, not this generation's numbering. */
export function normalizeDshCheckpointText(text: string): string {
    return text.replace(ACP_RENDER_TAG_SPAN, ACP_RENDER_TAG_PLACEHOLDER).replace(ACP_RENDER_TAG_REMNANT, ACP_RENDER_TAG_PLACEHOLDER);
}

/** #3033: numbering-invariant content fingerprint of a checkpoint text. */
export function dshCheckpointFingerprint(text: string): string {
    return createHash("sha256").update(normalizeDshCheckpointText(text), "utf8").digest("hex").slice(0, 16);
}

/** #3033: read back the fingerprint persisted by the session's last dsh-native
 *  rebase (session.metadata.dshCompactionFingerprint). */
export function storedDshCheckpointFingerprint(metadata: Record<string, unknown>): string | undefined {
    const fp = metadata.dshCompactionFingerprint;
    return typeof fp === "string" && fp !== "" ? fp : undefined;
}

type DshCheckpointMatch = {
    /** numbering-invariant fingerprint of the landed checkpoint's text */
    fingerprint: string;
    /** true when this checkpoint is the one the last rebase already consumed */
    suppressed: boolean;
};

/** #3033: full verdict of the #2432 framing scan — the carrier and novelty
 *  gates exactly as before, plus the fingerprint of the matched checkpoint and
 *  whether it is a REPLAY of the checkpoint this session already rebased onto
 *  (`rebasedFingerprint`). A replay must NOT rebase again: the reset re-issues
 *  the very ref numbers that made the ids churn, so every further rebase
 *  manufactures the next detection while the fold the client already accepted
 *  is destroyed again (the #3033 death spiral). Returns null when no candidate
 *  passes the gates. */
export function detectDshLocalCompactionCheckpoint(
    msgs: readonly { id?: unknown; role?: unknown; contentType?: unknown; text?: unknown; content?: unknown }[],
    knownIds?: ReadonlySet<string>,
    rebasedFingerprint?: string,
): DshCheckpointMatch | null {
    for (const m of msgs) {
        // ① CARRIER (#2621): only a user-role plain-text message can be a
        // checkpoint. Exclude every other producer of the marker string.
        if (m.role !== "user" || (m.contentType !== undefined && m.contentType !== "text")) continue;
        // ② NOVELTY (#2621): a freshly-landed checkpoint is a NEW id; a quoted
        // or replayed mention is an old id already in the pre-turn ref map.
        if (knownIds !== undefined && typeof m.id === "string" && knownIds.has(m.id)) continue;
        const text = typeof m.text === "string" && m.text !== "" ? m.text : textOfContent(m.content);
        if (text === "") continue;
        if (text.includes(DSH_CHECKPOINT_OPEN_TAG) || text.startsWith(DSH_CHECKPOINT_PREAMBLE_PREFIX)) {
            const fingerprint = dshCheckpointFingerprint(text);
            return { fingerprint, suppressed: rebasedFingerprint !== undefined && fingerprint === rebasedFingerprint };
        }
    }
    return null;
}

/** True when a freshly-LANDED dsh checkpoint is present in the resent history.
 *  Used by the prepare-openai / prepare-responses detectors (#2432) to tell a
 *  landed native compaction apart from ordinary history churn.
 *
 *  A LANDED checkpoint is specifically ONE user-role, plain-text message
 *  (dsh-compaction-basic replaces the shadowed region with a single
 *  user/message whose text starts with CHECKPOINT_PREAMBLE). The framing bytes
 *  are matched as before (open tag anywhere — it sits mid-message after
 *  preamble + blank line; or the preamble at message start). But #2621 taught
 *  that matching the framing BYTES ALONE is a false-positive machine: the
 *  string survives anywhere history QUOTES it — a tool result that read a
 *  transcript containing it, the model citing it in reasoning, bili's own
 *  compress summaries quoting it, an assistant message paraphrasing the
 *  preamble. Those carriers are structurally incapable of being a checkpoint,
 *  so two gates tighten the match to "a checkpoint just landed":
 *
 *   ① CARRIER — the message must be role="user" AND plain text
 *      (contentType "text" when typed). Tool results, reasoning blocks,
 *      tool-call arguments, and assistant prose are excluded outright. On the
 *      Anthropic lane a tool_result rides inside a wire role:"user" message but
 *      flattens to role="tool"/contentType="tool-result" (kernel
 *      anthropicToCore), so the role gate alone already drops it; the
 *      contentType gate is kept as belt-and-suspenders for any lane that maps
 *      a structured user block to a non-text contentType.
 *   ② NOVELTY — the message's raw id must NOT already be in the pre-turn ref
 *      map (`knownIds`, = Object.keys(session.state.messageRefs.byRaw) taken
 *      BEFORE processTurn). A freshly-landed checkpoint is by definition a NEW
 *      message; a historical quote/replay hits an OLD id. This closes the
 *      residual of ①: a user who literally typed/pasted the framing into a
 *      user message in an EARLIER turn is replayed as an old id, not a landing.
 *
 *  #3033 adds a third argument: `rebasedFingerprint` (the checkpoint
 *  fingerprint the session's last rebase persisted). A candidate whose content
 *  fingerprint EQUALS it is a replay of a compaction the state was already
 *  rebased onto — it reads false here and the caller skips the reset, which is
 *  what breaks the detect→reset→detect loop.
 *
 *  Reads the core-flattened text first (BiliMessage/CoreMessage carry prose in
 *  `.text`), falling back to a raw wire content field for direct callers. When
 *  `knownIds` is omitted the novelty gate is skipped (carrier gate only) —
 *  the google lane omits it (dsh speaks no google wire); the in-repo detectors
 *  that can pin the checkpoint's identity use
 *  `detectDshLocalCompactionCheckpoint` directly. */
export function carriesDshLocalCompactionSummary(
    msgs: readonly { id?: unknown; role?: unknown; contentType?: unknown; text?: unknown; content?: unknown }[],
    knownIds?: ReadonlySet<string>,
    rebasedFingerprint?: string,
): boolean {
    const hit = detectDshLocalCompactionCheckpoint(msgs, knownIds, rebasedFingerprint);
    return hit !== null && !hit.suppressed;
}

export type Refusal = { status: number; body: unknown };

const REFUSAL_MESSAGE =
    `dsh native compaction call refused by billion-context: bili owns compression on this lane (#1729, cf. #1772/#1206). ` +
    `A landed dsh compaction checkpoint durably shadows the raw conversation history, which destroys the proxy's compression substrate. ` +
    `To run dsh native compaction on this lane anyway, opt in explicitly: "allowDshCompaction": true in the bili config or env BILI_ALLOW_DSH_COMPACTION=1 (#2028).`;

/** Protocol-shaped refusal body (mirrors the #554 side-request guard shape so
 * clients render it natively). 422: a policy refusal of this one request — not
 * 401/403 (clients classify those as a credential failure and may disable the
 * credential) and not 408/409/429/5xx (SDK retry logic treats those as
 * transient). */
export function dshCompactionRefusal(protocol: string): Refusal {
    if (protocol === "anthropic") {
        return {
            status: 422,
            body: { type: "error", error: { type: "invalid_request_error", message: REFUSAL_MESSAGE } },
        };
    }
    return {
        status: 422,
        body: {
            error: {
                type: "server_error",
                code: "dsh_compaction_refused",
                message: REFUSAL_MESSAGE,
                retryable: false,
            },
        },
    };
}
