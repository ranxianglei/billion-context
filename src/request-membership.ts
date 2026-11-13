import type { CoreMessage } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import type { Session } from "./session.js";

// #4805: settle-side membership probe. A usage report is only "this
// conversation's truth" when the request that produced it actually carried
// this conversation's messages. Hosts stamp auxiliary personas (dsh
// auto-review and its relatives) with the SAME conversation id, so the
// session key alone cannot tell a main-turn report from a foreign
// 2-message one — but one remembered id can: a main turn resents the whole
// history and therefore contains the conversation's latest admitted
// message id, while an auxiliary payload never does. The probe key updates
// ONLY from member / first-turn / main-scale requests, so a foreign
// payload can neither pass nor hijack the needle (#2821 re-minted main
// turns are main-scale: they lose one settle and move the needle, healing
// on the next resend). Evidence ids are id-based ONLY (no content
// hashing): plugin lanes send the biliMsgIds envelope (#4491, any rollout
// state); every wire carries resent tool-call ids (model-minted,
// client-echoed — the only ids the raw protocol wires carry).
const MEMBERSHIP_RECORD_SCALE_RATIO = 0.25;

type RequestMembership = { member: boolean; needle: string | null };

// The payload upper estimate of the request that planted/moved the needle:
// before an anchor exists (fresh or fork child), the needle's own scale is
// the main-scale reference, so a tiny polluter cannot hijack it.

export function collectRequestIds(envelopeIds: unknown, msgs: CoreMessage[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(envelopeIds)) {
        for (const v of envelopeIds) {
            if (typeof v === "string" && v.length > 0 && v.length <= 512 && !v.startsWith("acp_summary_") && !seen.has(v)) {
                seen.add(v);
                out.push(v);
            }
        }
        if (out.length > 0) return out;
    }
    for (const m of msgs) {
        const id = m.toolCallId;
        if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    }
    return out;
}

export function isForeignMembership(m: RequestMembership | null | undefined): boolean {
    return m?.member === false;
}

export function probeRequestMembership(session: Session, ids: string[], payloadUpper: number): RequestMembership | null {
    const t = session.transient;
    if (!t) return null;
    if (ids.length === 0) {
        delete t.requestMembership;
        return null;
    }
    const needle = t.latestKnownMsgId ?? null;
    // First turn (no needle yet) abstains and plants one.
    const member = needle === null || ids.includes(needle);
    const verdict: RequestMembership = { member, needle };
    t.requestMembership = verdict;
    loggerLog("debug", `[${session.id}] [#4805] membership probe: ids=${ids.length} needle=${member ? "member" : "miss"} payloadUpper=${payloadUpper}`);
    // Needle discipline: only member / first-turn / main-scale requests may
    // move it — a tiny foreign payload must never own the needle, or the
    // next main turn would probe against the polluter's id and be gated.
    const referenceScale = session.stats.lastInputTokens > 0 ? session.stats.lastInputTokens : (t.needlePayloadUpper ?? 0);
    const mainScale = payloadUpper >= referenceScale * MEMBERSHIP_RECORD_SCALE_RATIO;
    if (member || mainScale) {
        t.latestKnownMsgId = ids[ids.length - 1];
        t.needlePayloadUpper = payloadUpper;
    }
    return verdict;
}
