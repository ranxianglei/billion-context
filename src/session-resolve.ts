// #2944 v2 / #7525 GA: order-primary session resolution — wire-neutral,
// content-blind.
//
// GA retirement (owner ruling 2026-11-23, following #7525's percent:100
// rollout of trustStampedId): the stamped id is the conversation key,
// unconditionally. The content-evidence ladder that used to sit under it —
// recorded order skeletons, the tag-change migration rungs, the
// |sub:aux / |sub:<fp> / |sub:task:<skel8> fork lanes, and the #5719
// msgid-rescue rung — could no longer change the key once the flag was on
// for every install (every reachable return was the raw id except the
// client-declared #5095 lane token), so the ladder is gone, with it the
// skeleton persistence of #3397 (src/order-persist.ts) and the legacy
// ladder file (src/persona-anchor.ts). The escape hatch
// (BILI_ROLLOUT_TRUST_STAMPED_ID=0) retires with it; reverting to
// fork-lane behavior is now a git-level operation.
//
// What remains is exactly the wire-visible key contract:
//
//   1. A valid #5095 dispatch lane token (the bili SubagentStart hook's
//      per-dispatch token riding the first user message) keys the request
//      onto its own per-dispatch lane:
//            <rawId>|sub:<fp16(personaTag)>:t:<token>
//      (two-segment <rawId>|sub:t:<token> when the tag is empty) —
//      byte-identical to the pre-retirement lane-token keys, so persisted
//      per-dispatch sessions keep their keys across the upgrade.
//   2. Everything else rides the stamped id verbatim.
//
// Unstamped (anonymous) traffic never reaches this resolver: the caller
// provenance contract (client-minted, unambiguous id — the id table in the
// old v2 header) is enforced upstream, and identity-less requests stay on
// the anonymous prefix-affinity ladder (src/prefix-affinity.ts), which this
// retirement does not touch.

import { createHash } from "node:crypto";
import { isClaudeLaneToken } from "./claude-lane-token.js";

export type SessionOrderResolution = {
    key: string;
    /** "raw" = the stamped id rides verbatim; "derived-persona" = a valid
     *  #5095 lane token keyed its own per-dispatch lane. */
    action: "raw" | "derived-persona";
    /** Human-readable reason for the derived branch (log surface). */
    reason?: string;
};

const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

/** #2944 order-primary resolution (post-#7525 GA). `rawId` MUST be a
 *  client-minted, unambiguous conversation id (the caller's provenance
 *  contract — ids that fail it stay on the anonymous ladder).
 *
 *  `personaTag` is consumed ONLY by the lane-token branch (it is the
 *  `fp16(tag)` segment of the lane key, so persisted token lanes stay
 *  byte-stable across tag wording changes of the same persona); a valid
 *  `laneToken` (#5095 D1-C) outranks everything: the token — not the tag,
 *  not the history — is what isolates parallel same-persona dispatches,
 *  and a token'd request never claims the raw id. */
export function resolveSessionOrder(rawId: string, personaTag?: string, laneToken?: string): SessionOrderResolution {
    const tag = personaTag !== undefined && personaTag.trim().length > 0 ? personaTag : "";
    if (isClaudeLaneToken(laneToken)) {
        // #5095 D1-C: deterministic per-dispatch lane. The token is unique
        // per dispatch, so no corroboration is needed: the same token on
        // every pass of one dispatch recomputes the same key; two parallel
        // dispatches of the SAME persona (identical tag hash) get distinct
        // keys by construction.
        const laneKey = `${rawId}|sub:${tag !== "" ? `${fp16(tag)}:` : ""}t:${laneToken}`;
        return { key: laneKey, action: "derived-persona", reason: "dispatch lane token — per-dispatch persona lane (#5095)" };
    }
    return { key: rawId, action: "raw", reason: "client-stamped id rides verbatim (trust-stamped-id GA, #7525)" };
}

/** #5686 visibility seam (optional): observers of state-changing outcomes.
 *  The raw path is the steady state (silent); derived lanes are the
 *  incident class. The callback is best-effort: a throwing observer must
 *  never break resolution. */
type SessionResolveObserver = (rawId: string, r: SessionOrderResolution) => void;

/** handle.ts wiring adapter: raw id + the request's persona tag in, the
 *  conversation key out. */
export function personaConversationOrder(rawId: string, personaTag?: string, laneToken?: string, onResolve?: SessionResolveObserver): string {
    const res = resolveSessionOrder(rawId, personaTag, laneToken);
    if (onResolve !== undefined) {
        try {
            onResolve(rawId, res);
        } catch {
            // observer hook — diagnostics only
        }
    }
    return res.key;
}
