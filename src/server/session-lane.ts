/**
 * C5 (PR #7684, follow-up 2 of #7439): make a session's WIRE-LANE switch
 * explicit at the request boundary.
 *
 * Why this exists: the stored history (egress flow rows, snapshots) is
 * deliberately dialect-neutral — ruling 7439-1 keeps the protocol OUT of
 * the rows, and every re-render (served turns, folds, snapshots) renders
 * the whole conversation on the CURRENT wire. That is exactly what makes
 * model/protocol switching work — and exactly why a lane change is
 * invisible in the log stream: the same conversation simply speaks a
 * different dialect from some turn on, with no event recorded.
 *
 * This module records the switch at the ONE point every prepared request
 * passes (runPrepare in handle.ts): one loud line per switch with the
 * bounded, explicit loss list (what the stored conversation carries that a
 * cross-wire render degrades), a session-local counter, and the previous
 * lane kept in the session's persisted metadata (no schema change; the
 * comparison survives a restart).
 *
 * The loss list is the contract, not a suggestion — every item on it is a
 * rendering choice the kernel makes explicitly (degrade to text /
 * placeholder / drop-with-reason), never a silent corruption:
 *
 *   - thinking signatures are lane-private blobs: a re-render on another
 *     wire emits the thinking TEXT as plain text, never re-attested
 *   - redacted thinking becomes a placeholder
 *   - the tool-error flag only rides the anthropic wire (is_error); on the
 *     other wires it degrades to a note in the result text
 *   - mid-system placement is re-voiced per wire (system/developer/user
 *     run split differs)
 *   - Responses-only items (mcp_list_tools, additional_tools, unknown
 *     types) never enter the stored log at all
 *
 * Ids across the switch: pinned host ids survive (the pin is per stored
 * core, wire-granularity since Part 2); content-derived ids are
 * wire-stable by the cross-protocol golden (#3640/#3642).
 */
import type { Session } from "../session.js";
import type { BiliMessage } from "acp-kernel/wire";












type LogFn = (level: string, msg: string) => void;

const REDACTED_PLACEHOLDER = "[redacted_thinking]";

/** Presence evidence for the lane-locked features, accumulated per session. */
type LaneLockedEvidence = {
    signedThinking?: number;
    redacted?: number;
    images?: number;
    toolErrors?: number;
    midSystem?: number;
};

function observeInbound(messages: readonly unknown[]): LaneLockedEvidence {
    const e: LaneLockedEvidence = {};
    let signed = 0, redacted = 0, images = 0, toolErrors = 0, midSystem = 0;
    messages.forEach((m, i) => {
        const b = m as BiliMessage;
        if (b.thinkingSignature !== undefined || b.googleThoughtSignature !== undefined) signed++;
        if (typeof b.text === "string" && b.text.includes(REDACTED_PLACEHOLDER)) redacted++;
        if (b.imagePart === true || b.imageBase64 !== undefined) images++;
        if (b.toolIsError === true) toolErrors++;
        if ((b.role as string) === "system" || (b.role as string) === "developer") midSystem++;
    });
    if (signed > 0) e.signedThinking = signed;
    if (redacted > 0) e.redacted = redacted;
    if (images > 0) e.images = images;
    if (toolErrors > 0) e.toolErrors = toolErrors;
    if (midSystem > 0) e.midSystem = midSystem;
    return e;
}

function mergeEvidence(prev: LaneLockedEvidence, cur: LaneLockedEvidence): LaneLockedEvidence {
    const out: LaneLockedEvidence = { ...prev };
    for (const k of ["signedThinking", "redacted", "images", "toolErrors", "midSystem"] as const) {
        out[k] = Math.max(prev[k] ?? 0, cur[k] ?? 0); // resends would double-count; the max is the honest bound
    }
    return out;
}

function renderLosses(e: LaneLockedEvidence): string {
    const parts: string[] = [];
    if (e.signedThinking) parts.push(`${e.signedThinking} signed thinking block(s) -> plain text (signatures are lane-private, never re-attested)`);
    if (e.redacted) parts.push(`${e.redacted} redacted-thinking placeholder(s) -> stay placeholders`);
    if (e.images) parts.push(`${e.images} image(s) -> re-rendered as data-URL / "[image]" text`);
    if (e.toolErrors) parts.push(`${e.toolErrors} tool-error result(s) -> the error flag only rides the anthropic wire`);
    if (e.midSystem) parts.push(`${e.midSystem} mid-body system/developer message(s) -> re-voiced per wire`);
    return parts.length > 0
        ? parts.join("; ") + " (Responses-only items, if any, were never stored)"
        : "none observed (the stored conversation is pure text/tools and carries across wires verbatim)";
}

const EVIDENCE_META_KEY = "laneLockedEvidence";

/**
 * Note the lane (wire dialect) of a prepared request for the session.
 * Emits ONE loud line when the lane changed since the previous request:
 * old -> new, the session-local switch counter, and the explicit loss list
 * computed from the lane-locked content observed so far in this session.
 * Steady-state (same lane) and first-observation are silent.
 */
export function noteSessionLaneSwitch(
    session: Session,
    protocol: string | undefined,
    inbound: readonly unknown[],
    log: LogFn,
): void {
    if (typeof protocol !== "string" || protocol.length === 0) return;
    const meta = (session.metadata ??= {});
    const evidence = mergeEvidence(
        (typeof meta[EVIDENCE_META_KEY] === "object" && meta[EVIDENCE_META_KEY] !== null ? meta[EVIDENCE_META_KEY] as LaneLockedEvidence : {}),
        observeInbound(inbound),
    );
    meta[EVIDENCE_META_KEY] = evidence;

    const prev = typeof meta.lastLaneKey === "string" ? meta.lastLaneKey : undefined;
    if (prev === undefined) {
        meta.lastLaneKey = protocol;
        return; // first observed lane — not a switch
    }
    if (prev === protocol) return; // steady state
    meta.lastLaneKey = protocol;
    const count = (typeof meta.laneSwitchCount === "number" ? meta.laneSwitchCount : 0) + 1;
    meta.laneSwitchCount = count;
    log(
        "warn",
        `[${session.id}] [lane-switch] wire changed ${prev} -> ${protocol} (switch #${count}): stored history is dialect-neutral, so from this turn on EVERY re-render (served turns, folds, snapshots) renders the whole conversation on the "${protocol}" wire. Cross-lane losses: ${renderLosses(evidence)}. Pinned host ids survive the switch; content-derived ids are wire-stable (#3640).`,
    );
}
