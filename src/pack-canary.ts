import { createHash } from "node:crypto";
import type { Session } from "./session.js";

/** Default rollout percentage for the prompt-pack canary (#1408): 10% of
 *  sessions whose merged compress.promptPack is unset at every level are
 *  assigned the builtin `lean` pack; the rest stay on `default`. */
export const PROMPT_PACK_CANARY_PCT_DEFAULT = 10;

/** Parse BILI_PROMPT_PACK_CANARY_PCT: an integer in [0, 100]. Anything else —
 *  unset, non-numeric, non-integer, or out of range — falls back to the
 *  default 10 (a mistyped knob must never silently widen or kill the rollout). */
export function promptPackCanaryPct(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.BILI_PROMPT_PACK_CANARY_PCT;
    if (raw === undefined) return PROMPT_PACK_CANARY_PCT_DEFAULT;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return PROMPT_PACK_CANARY_PCT_DEFAULT;
    const n = Number(trimmed);
    return n >= 0 && n <= 100 ? n : PROMPT_PACK_CANARY_PCT_DEFAULT;
}

/** Deterministic per-session eligibility for the lean pack: a stable bucket
 *  derived from the session id, so the answer is identical across restarts
 *  and proxy instances, and monotonic in pct (raising the knob only ever
 *  admits more sessions, never re-rolls one). */
export function isEligibleForLeanPack(sessionId: string, pct: number): boolean {
    if (pct <= 0) return false;
    if (pct >= 100) return true;
    const digest = createHash("sha256").update(sessionId, "utf8").digest();
    const bucket = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 100;
    return bucket < pct;
}

/** Sticky canary assignment (#1408). Returns the effective builtin pack name
 *  for a session whose merged compress.promptPack is unset at every level.
 *
 *  Semantics (chosen over pure per-request hash evaluation — see #1408): the
 *  FIRST call assigns by id-hash eligibility against the CURRENT pct and
 *  stamps the choice onto session.meta.packCanary (persisted with the
 *  session); every later call just reads the stamp. The assignment therefore
 *  never re-rolls when the knob moves: raising the pct admits not-yet-
 *  assigned sessions at their own hash, and rolling back to 0 stops NEW lean
 *  assignments without flipping any already-assigned session mid-life. */
export function resolveStickyPackAssignment(
    session: Pick<Session, "id" | "meta">,
    log: (level: string, msg: string) => void,
    env: NodeJS.ProcessEnv = process.env,
): "lean" | "default" {
    const stamped = session.meta.packCanary;
    if (stamped === "lean" || stamped === "default") return stamped;
    const pct = promptPackCanaryPct(env);
    const pack: "lean" | "default" = isEligibleForLeanPack(session.id, pct) ? "lean" : "default";
    session.meta.packCanary = pack;
    log("info", `prompt-pack canary: ${pack} (pct=${pct}, session=${session.id})`);
    return pack;
}
