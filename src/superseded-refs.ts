import { type Session } from "./session.js";

/** #4316 layer 3 PR3/3, #4797 rework: resolve a tool call's refs
 *  against the CURRENT live map first, the superseded map second, and refuse
 *  only genuinely-dead cites. Shared by compress (ranges) and decompress
 *  (range endpoints, #5049 item 4) so both lanes translate pre-restamp
 *  citations identically.
 *
 *  The original span-scan refused any range with a superseded KEY anywhere
 *  between its endpoints — but the restamp's vacated numbers can be handed to
 *  other messages as seq+1 targets in the same sweep, so in a dense space a
 *  superseded key is routinely ALSO the live ref of a different message
 *  (exactly the numbers acp_status advertises). That made the guard reject
 *  every advertised range and dead-loop the session: "call acp_status" →
 *  status lists the same live numbers → refused again — the proxy's own
 *  preflight rescue included (#4797).
 *
 *  Resolution ladder, per ENDPOINT (span folding is endpoint-defined; the
 *  interior number scan only manufactured false hits):
 *  1. live in the current map → keep as-is (collision-band artifact, the
 *     common case for numbers straight out of acp_status / the nudge);
 *  2. superseded key (genuinely vacated) → identity-preserving translation
 *     oldRef → rawId → the same message's current ref — a model citing a
 *     number it saw BEFORE the restamp folds the SAME messages, never the
 *     new owner of that number;
 *  3. neither → leave to the kernel's boundary-not-found handling.
 *  Refusal only when an endpoint is a superseded key whose translation
 *  dead-ends (the message lost its mapping entirely — an honest stale cite).
 *
 *  Transitional honesty: for sessions restamped by kernels WITHOUT the
 *  superseded-liveness prune, case 1 can in principle swallow a resent
 *  pre-restart call's intent (number now owned by someone else). The replay
 *  window is seconds; the deadlock it replaces is permanent — live-first is
 *  the right trade, and the kernel prune removes the ambiguity entirely for
 *  fresh restamps. */
interface SupersededResolution<T extends { startRef: string; endRef: string } = { startRef: string; endRef: string; summary: string }> {
    rejection: string | null;
    translatedRanges: T[];
    translated: number;
}

export function supersededRefRejection<T extends { startRef: string; endRef: string }>(
    ranges: T[],
    session: Session,
): SupersededResolution<T> {
    const superseded = session.restampSuperseded;
    const out: SupersededResolution<T> = { rejection: null, translatedRanges: [], translated: 0 };
    if (!superseded || superseded.size === 0) {
        out.translatedRanges = ranges.map((r) => ({ ...r }));
        return out;
    }
    const byRef = session.state.messageRefs?.byRef ?? {};
    const byRaw = session.state.messageRefs?.byRaw ?? {};
    const dead: string[] = [];
    const resolveEndpoint = (ref: string): string => {
        if (byRef[ref] !== undefined) return ref;
        const rawId = superseded.get(ref);
        if (rawId === undefined) return ref;
        const next = byRaw[rawId];
        if (typeof next === "string" && next !== ref && byRef[next] === rawId) {
            out.translated++;
            return next;
        }
        dead.push(ref);
        return ref;
    };
    out.translatedRanges = ranges.map((range) => ({
        ...range,
        startRef: resolveEndpoint(range.startRef),
        endRef: resolveEndpoint(range.endRef),
    }));
    if (dead.length === 0) return out;
    const listed = dead.slice(0, 5).join(", ");
    const more = dead.length > 5 ? ` (+${dead.length - 5} more)` : "";
    out.rejection = `ref(s) ${listed}${more} were re-numbered by the ledger alignment and no longer resolve to a live message. Re-read the current labels with acp_status and re-issue.`;
    return out;
}
