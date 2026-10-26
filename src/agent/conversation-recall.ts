/**
 * Negotiated conversation recall (#4082, #3918, #2975).
 *
 * The native lanes attribute a model request to a host session by reading the
 * host's execution context (AsyncLocalStorage initiator). That context is
 * MISSING on the paths the host drives outside an agent turn — quota/429
 * retries, model switches, and post-resume resends — so those dispatches fall
 * out of the takeover gate into raw DIRECT sends: compression off, guards
 * off, and (because the host keeps growing the same conversation) the damage
 * is permanent for that session (#3918).
 *
 * This module is the fallback identity: while attribution WORKS, the shim
 * learns `lane → (session id, boundary fingerprint)` — the boundary is the
 * fingerprint of the LAST message of the attributed request's body. When
 * attribution is later missing on the same lane, a dispatch whose history
 * CONTAINS a remembered boundary is provably that session's continuation
 * (retries and model switches resend the identical history; that is the
 * problem AND the proof), and the gate can claim it again with the server's
 * own session id.
 *
 * Safety rules:
 *  - The boundary must be CONTAINED in the incoming history and the match
 *    must be UNIQUE across the lane's remembered sessions — otherwise no
 *    stamp (behavior stays exactly today's direct send). Never guess.
 *  - A fork that diverges from mid-history does not contain the parent's
 *    latest boundary → never claimed. Only a fork copied from the very END is
 *    physically indistinguishable from a continuation; the TTL window plus
 *    reconcile drift isolation bound that rare² case (and #2399 adoption
 *    semantics make even it semantically sound).
 *  - A message with neither content nor tool_calls (null/undefined/""/[])
 *    carries no identity — it is never fingerprinted, so a degenerate
 *    boundary is never learned and never matched (#4110: on the OpenAI
 *    wire every pure tool-call turn has content:null, and hashing only
 *    {role, content} gave them ALL one shared fingerprint across sessions).
 *  - Entries expire (RECALL_TTL_MS) and each lane keeps at most
 *    RECALL_PER_LANE sessions (LRU) — retries happen within seconds of the
 *    original dispatch, this is a short-window bridge, not a registry.
 */
import { createHash } from "node:crypto";

const RECALL_TTL_MS = 10 * 60_000;
const RECALL_PER_LANE = 8;
const RECALL_MAX_LANES = 64;

type ConversationRecallStats = {
    lanes: number;
    sessions: number;
    learned: number;
    recalled: number;
    rejectedNoLane: number;
    rejectedNoBoundary: number;
    rejectedAmbiguous: number;
    expired: number;
};

type LaneEntry = { sid: string; boundaryFp: string; at: number };

const lanes = new Map<string, Map<string, LaneEntry>>();
const stats: ConversationRecallStats = {
    lanes: 0,
    sessions: 0,
    learned: 0,
    recalled: 0,
    rejectedNoLane: 0,
    rejectedNoBoundary: 0,
    rejectedAmbiguous: 0,
    expired: 0,
};

function sweep(now: number): void {
    for (const [laneKey, perLane] of lanes) {
        for (const [sid, entry] of perLane) {
            if (now - entry.at > RECALL_TTL_MS) {
                perLane.delete(sid);
                stats.expired++;
            }
        }
        if (perLane.size === 0) lanes.delete(laneKey);
    }
    while (lanes.size > RECALL_MAX_LANES) {
        // Simple bound: drop the least recently updated lane.
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [laneKey, perLane] of lanes) {
            for (const entry of perLane.values()) {
                if (entry.at < oldestAt) {
                    oldestAt = entry.at;
                    oldestKey = laneKey;
                }
            }
        }
        if (oldestKey === undefined) break;
        lanes.delete(oldestKey);
    }
    stats.lanes = lanes.size;
    stats.sessions = [...lanes.values()].reduce((n, perLane) => n + perLane.size, 0);
}

/**
 * Lane key: endpoint origin + pathname only. Query strings can carry
 * per-request noise, the model field changes on exactly the #3918 switch-
 * model retry this must catch, and auth tokens rotate (bearer refresh / key
 * swap — an auth-keyed lane would be orphaned on the very retry the bridge
 * exists for). The lane is only the SEARCH NAMESPACE; the identity evidence
 * is the boundary fingerprint plus its uniqueness across the lane.
 */
export function recallLaneKey(url: string): string {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
}

/** Cheap probe for gate-side short-circuiting: no learned session on this
 * lane ⇒ no body parsing or fingerprinting is worth doing at all (agentless
 * sidecars hit this path constantly with bodies that can never match). */
export function recallLaneHasEntries(laneKey: string): boolean {
    const perLane = lanes.get(laneKey);
    return perLane !== undefined && perLane.size > 0;
}

/** Stable fingerprint of one wire message (byte-stable: hosts serialize
 * deterministically, and a retry resends the identical serialization).
 * #4110: the hash covers tool_calls too (pure tool-call turns carry
 * content:null on the OpenAI wire — hashing {role, content} alone made every
 * such message in every session share ONE fingerprint); a message with no
 * content AND no tool_calls proves nothing and gets NO fingerprint. */
function recallFingerprintOfMessage(message: unknown): string | undefined {
    if (typeof message !== "object" || message === null) return undefined;
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (typeof role !== "string" || (content !== undefined && typeof content !== "string" && typeof content !== "object")) {
        return undefined;
    }
    if (!recallMessageCarriesEvidence(content, toolCalls)) return undefined;
    try {
        // JSON.stringify drops undefined keys, so messages without
        // tool_calls keep their pre-#4110 fingerprints unchanged.
        return createHash("sha256").update(JSON.stringify({ role, content, toolCalls })).digest("hex").slice(0, 24);
    } catch {
        return undefined;
    }
}

/** #4110: a non-empty tool_calls list or non-empty content identifies a
 * message; content null/undefined/""/[] without tool_calls is degenerate —
 * identical in every session, usable as evidence nowhere. */
function recallMessageCarriesEvidence(content: unknown, toolCalls: unknown): boolean {
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;
    if (content === null || content === undefined) return false;
    if (typeof content === "string") return content.length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return true;
}

/** Fingerprints of every message in a wire `messages` array. */
export function recallHistoryFingerprints(messages: unknown): Set<string> {
    const out = new Set<string>();
    if (!Array.isArray(messages)) return out;
    for (const m of messages) {
        const fp = recallFingerprintOfMessage(m);
        if (fp !== undefined) out.add(fp);
    }
    return out;
}

/** The boundary fingerprint of a body: its LAST message that carries
 * evidence (#4110: degenerate trailing messages are skipped, so a boundary
 * that proves nothing is never learned). */
export function recallBoundaryOfMessages(messages: unknown): string | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const fp = recallFingerprintOfMessage(messages[i]);
        if (fp !== undefined) return fp;
    }
    return undefined;
}

/** Learn (attribution ok): this session's latest dispatch boundary on this lane. */
export function learnConversation(laneKey: string, sid: string, boundaryFp: string): void {
    const now = Date.now();
    sweep(now);
    let perLane = lanes.get(laneKey);
    if (perLane === undefined) {
        perLane = new Map();
        lanes.set(laneKey, perLane);
    }
    // LRU touch + TTL refresh.
    perLane.delete(sid);
    while (perLane.size >= RECALL_PER_LANE) {
        let oldestSid: string | undefined;
        let oldestAt = Infinity;
        for (const [s, e] of perLane) {
            if (e.at < oldestAt) {
                oldestAt = e.at;
                oldestSid = s;
            }
        }
        if (oldestSid === undefined) break;
        perLane.delete(oldestSid);
    }
    perLane.set(sid, { sid, boundaryFp, at: now });
    stats.learned++;
    stats.lanes = lanes.size;
    stats.sessions = [...lanes.values()].reduce((n, l) => n + l.size, 0);
}

/**
 * Recall (attribution missing): the UNIQUE remembered session on this lane
 * whose boundary fingerprint is contained in the incoming history. Undefined
 * = no evidence, keep today's behavior.
 */
export function recallConversation(laneKey: string, historyFps: Set<string>): string | undefined {
    const now = Date.now();
    sweep(now);
    const perLane = lanes.get(laneKey);
    if (perLane === undefined || perLane.size === 0) {
        stats.rejectedNoLane++;
        return undefined;
    }
    const hits: string[] = [];
    for (const entry of perLane.values()) {
        if (historyFps.has(entry.boundaryFp)) hits.push(entry.sid);
    }
    if (hits.length === 0) {
        stats.rejectedNoBoundary++;
        return undefined;
    }
    if (hits.length > 1) {
        stats.rejectedAmbiguous++;
        return undefined;
    }
    // LRU touch so an active session survives idle siblings.
    const entry = perLane.get(hits[0]);
    if (entry !== undefined) {
        perLane.delete(hits[0]);
        entry.at = now;
        perLane.set(hits[0], entry);
    }
    stats.recalled++;
    return hits[0];
}

export function conversationRecallStats(): Readonly<ConversationRecallStats> {
    return { ...stats };
}

export function __resetConversationRecallForTests(): void {
    lanes.clear();
    stats.lanes = 0;
    stats.sessions = 0;
    stats.learned = 0;
    stats.recalled = 0;
    stats.rejectedNoLane = 0;
    stats.rejectedNoBoundary = 0;
    stats.rejectedAmbiguous = 0;
    stats.expired = 0;
}

/** Test seam: age every entry by the given ms (TTL expiry scenarios). */
export function __ageConversationRecallForTests(ms: number): void {
    for (const perLane of lanes.values()) {
        for (const entry of perLane.values()) entry.at -= ms;
    }
}
