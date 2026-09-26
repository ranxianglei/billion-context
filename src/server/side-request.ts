import type { WireProtocol } from "../util.js";
import { estimateRawBodyTokens } from "../preflight.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { reserveOutputHeadroom, shouldReserveOutputHeadroom } from "../util.js";
import { type ResolvedImageBilling } from "../image-tokens.js";
import type { Session } from "../session.js";

// #388: side requests (title-gen etc.) share the main session key but must not
// touch kernel state. Identified by a tiny output budget (same heuristic as
// prepareOpenai's isTitleGen); a missing/non-positive budget is never a side req.
// #546: a non-empty tools array marks an agent MAIN turn — clients that size the
// output budget from their raw (uncompressed) history shrink max_tokens to
// <=200 on long sessions; that must never demote the request to a side pass
// (title-gen requests never carry tools).
export const SIDE_REQUEST_MAX_TOKENS = 200;
export function isSideRequest(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    const field = outputBudgetField(parsed);
    if (!field) return false;
    const raw = readOutputBudget(p, field);
    return typeof raw === "number" && raw > 0 && raw <= SIDE_REQUEST_MAX_TOKENS;
}

export type OutputBudgetField = "max_tokens" | "max_completion_tokens" | "max_output_tokens" | "generationConfig.maxOutputTokens";

/** The declared output budget, proto-agnostically. Gemini nests it under
 *  `generationConfig` (the dotted field name above), the OpenAI/Anthropic
 *  families keep it flat, so every reader goes through these two accessors. */
export function outputBudgetField(parsed: unknown): OutputBudgetField | null {
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
        if (typeof p[field] === "number" && (p[field] as number) > 0) return field;
    }
    const gen = p.generationConfig;
    if (gen && typeof gen === "object") {
        const v = (gen as Record<string, unknown>).maxOutputTokens;
        if (typeof v === "number" && v > 0) return "generationConfig.maxOutputTokens";
    }
    return null;
}

export function readOutputBudget(parsed: Record<string, unknown>, field: OutputBudgetField): number | undefined {
    if (field !== "generationConfig.maxOutputTokens") {
        const v = parsed[field];
        return typeof v === "number" ? v : undefined;
    }
    const gen = parsed.generationConfig;
    if (!gen || typeof gen !== "object") return undefined;
    const v = (gen as Record<string, unknown>).maxOutputTokens;
    return typeof v === "number" ? v : undefined;
}

export function writeOutputBudget(parsed: Record<string, unknown>, field: OutputBudgetField, value: number): void {
    if (field !== "generationConfig.maxOutputTokens") {
        parsed[field] = value;
        return;
    }
    const gen = parsed.generationConfig;
    parsed.generationConfig = { ...(gen && typeof gen === "object" ? (gen as Record<string, unknown>) : {}), maxOutputTokens: value };
}

/** #546: clients that derive the output budget from their RAW (uncompressed)
 *  history drive it down to <=200 tokens on long sessions, then truncate every
 *  reply mid-thought — the model cannot even emit a compress tool call, so the
 *  loop can never rescue the session. The proxy's compressed view still fits
 *  the window, so remember the healthy budget per session (last non-starved
 *  value wins) and restore it on tool-carrying main requests whose budget has
 *  starved. Mutates `parsed` in place BEFORE prepare() serializes it. */
export function restoreOutputBudget(
    parsed: unknown,
    session: { id: string; metadata: Record<string, unknown> },
    log: (level: string, msg: string) => void,
): void {
    const field = outputBudgetField(parsed);
    if (!field) return;
    const p = parsed as Record<string, unknown>;
    const value = readOutputBudget(p, field);
    if (value === undefined) return;
    if (value > SIDE_REQUEST_MAX_TOKENS) {
        session.metadata.outputBudgetHighWater = value;
        return;
    }
    if (!Array.isArray(p.tools) || p.tools.length === 0) return;
    const highWater = session.metadata.outputBudgetHighWater;
    if (typeof highWater === "number" && highWater > SIDE_REQUEST_MAX_TOKENS) {
        writeOutputBudget(p, field, highWater);
        log("info", `[${session.id}] output budget restored ${value} -> ${highWater} (#546: client shrank it from its raw-history estimate)`);
    }
}

// defaultCountTokens counts CJK per-char but real tokenizers encode CJK at
// ~0.6-0.75 tokens/char, so CJK-heavy raw bodies over-estimate by up to ~1.6x.
// Everywhere else that bias is safe (it only compresses earlier); here it
// would hard-deny a payload that really fits (retryable: false), so tolerate
// 15% over the window — borderline payloads forward, and a real overflow 400
// still teaches the learned limit.
const SIDE_REQUEST_GUARD_TOLERANCE = 1.15;

/** #554: side requests are forwarded VERBATIM (no pipeline, #388), so a payload
 *  over the upstream window is a guaranteed 400 that preflight can never fix
 *  from this path. Block here instead of forwarding: estimate the RAW body
 *  (CJK-aware text + image tokens) against the effective window — the declared
 *  modelContextLimit (#987: no learned window exists anymore) minus the output
 *  reservation on wires where output counts against the window. blocked=false
 *  with limit<=0 means "window unknown — forward as before". blocked requires
 *  estimate >= limit x SIDE_REQUEST_GUARD_TOLERANCE (estimator bias). */
export function sideRequestGuard(
    parsed: unknown,
    protocol: WireProtocol,
    modelContextLimit: number,
    imageBilling: ResolvedImageBilling = "bytes",
    headroomCap: number = 1,
    armedLimit: number = 0,
): { blocked: boolean; estimate: number; limit: number } {
    let limit = modelContextLimit;
    // #987: no learned window exists, but a usage-grounded arm left by an
    // overflow 400 (the upstream STATED that size) is live evidence this
    // session cannot exceed it — a side request above it is the same
    // guaranteed 400 (#554 loop). The arm is one-shot memory (a successful
    // turn's usage overwrites it); it never re-centers the declared window.
    if (armedLimit > 0 && (limit <= 0 || armedLimit < limit)) limit = armedLimit;
    const field = outputBudgetField(parsed);
    const maxOut = (field ? readOutputBudget(parsed as Record<string, unknown>, field) : undefined) ?? 0;
    if (limit > 0 && shouldReserveOutputHeadroom(protocol)) limit = reserveOutputHeadroom(limit, maxOut, headroomCap);
    const estimate = estimateRawBodyTokens(parsed) + imageTokensInParsedBody(protocol, parsed, imageBilling);
    return { blocked: limit > 0 && estimate >= limit * SIDE_REQUEST_GUARD_TOLERANCE, estimate, limit };
}

// #1309/#1307: normal-budget auxiliary requests (DSH auto-review, classifiers,
// title-gen) ride the main session key with 1-2 brand-new messages and no
// tools; they escape isSideRequest's ≤200 budget test and pollute
// snapshot/usage/nudge state (#1307) and feed reapOrphanBlocks (3 in a row
// deactivates every active block, #1206). Unified decision point: route them
// onto the existing #388 side-passthrough lane (no refs minted, no usage
// recorded, no nudge baseline movement, no orphan-GC feed, no snapshot write).
//
// PRIMARY DISCRIMINATOR — identity affinity against the remembered anchor
// view: a MAIN turn always re-sends previously-seen history verbatim
// (content-addressed raw ids require byte-stable resends — the system's own
// invariant), so "does this request's history continue the remembered view?"
// decides the lane. A request carrying at least one message the anchor view
// already knows (at ANY position — a front-trimmed tail, an edited middle, a
// retry) is a continuation → full pipeline. Only a request whose EVERY message
// is unknown to the anchor diverges from it at the first message → side lane.
// The session key only routes to the anchor record; affinity decides.
//
// CORROBORATION / BOOTSTRAP — the resend latch: set once when a main-line
// request re-sent at least one message verbatim from the previously recorded
// view. It separates the two otherwise-indistinguishable request classes
// (≤2 fresh messages, no tools, same session key): auxiliary overlays, which
// only appear on keys carrying a LIVE evolving conversation that re-sends its
// history, versus legitimate turns of stateless light clients that never
// re-send history and must keep today's full-pipeline behavior (#1075
// contract: a single no-tools normal-budget request consumes exactly one ref).
// Where affinity has nothing to compare against (no anchor yet — the first
// requests of a session) the latch is unset too, so the bootstrap case
// resolves to the full pipeline.
//
// FAIL-SAFE DIRECTION (owner-pinned, #1309): every affinity failure — no
// anchor, latch unset, unrecognized wire shape, partial match — falls back to
// TODAY'S FULL PIPELINE, treated as legitimate divergence (client-side
// trim/edit/reset). Misclassifying the main conversation as side traffic is
// the one unrecoverable failure; leaving a side request un-isolated is merely
// the #1308-era status quo (the #1312 write-point guard sits behind this
// routing as defense-in-depth).
export const AUXILIARY_MAX_MESSAGES = 2;

// Anchor qualification: only main-line views of at least this many messages
// (a real user/assistant/user exchange) may BECOME the anchor. A brand-new
// <=2-message conversation on a reused session key is a conversation OPENER,
// not an overlay — there is no substantive live history to shadow — and a
// side request arriving before any main request must not bootstrap the
// anchor (or the remembered view) with its tiny history (no anchor poisoning).
export const AUXILIARY_MIN_MAIN_VIEW = 3;

export type WireTexts = Array<{ role: string; text: string }>;

/** Extract (role, text) pairs from a raw wire body, protocol-agnostically.
 *  Returns undefined for any unrecognized shape — callers must treat that as
 *  "cannot classify" and keep the status quo (full pipeline). */
export function extractWireTexts(protocol: WireProtocol, parsed: unknown): WireTexts | undefined {
    if (!parsed || typeof parsed !== "object") return undefined;
    const p = parsed as Record<string, unknown>;
    try {
        if (protocol === "openai" || protocol === "anthropic") {
            const msgs = p.messages;
            if (!Array.isArray(msgs)) return undefined;
            const out: WireTexts = [];
            for (const m of msgs) {
                if (!m || typeof m !== "object") return undefined;
                const mm = m as Record<string, unknown>;
                if (typeof mm.role !== "string") return undefined;
                const c = mm.content;
                let text: string;
                if (typeof c === "string") {
                    text = c;
                } else if (Array.isArray(c)) {
                    const parts: string[] = [];
                    for (const part of c) {
                        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
                            parts.push((part as Record<string, unknown>).text as string);
                        }
                    }
                    text = parts.join("\n");
                } else {
                    return undefined;
                }
                out.push({ role: mm.role, text });
            }
            return out;
        }
        if (protocol === "google") {
            const contents = p.contents;
            if (!Array.isArray(contents)) return undefined;
            const out: WireTexts = [];
            for (const c of contents) {
                if (!c || typeof c !== "object") return undefined;
                const cc = c as Record<string, unknown>;
                const role = typeof cc.role === "string" ? cc.role : "user";
                const parts = cc.parts;
                if (!Array.isArray(parts)) return undefined;
                const texts: string[] = [];
                for (const part of parts) {
                    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
                        texts.push((part as Record<string, unknown>).text as string);
                    }
                }
                out.push({ role, text: texts.join("\n") });
            }
            return out;
        }
        const input = p.input;
        if (typeof input === "string") return [{ role: "user", text: input }];
        if (!Array.isArray(input)) return undefined;
        const out: WireTexts = [];
        for (const item of input) {
            if (!item || typeof item !== "object") return undefined;
            const it = item as Record<string, unknown>;
            const type = typeof it.type === "string" ? it.type : "message";
            if (type !== "message") {
                out.push({ role: type, text: "" });
                continue;
            }
            const role = typeof it.role === "string" ? it.role : "user";
            const c = it.content;
            let text: string;
            if (typeof c === "string") {
                text = c;
            } else if (Array.isArray(c)) {
                const parts: string[] = [];
                for (const part of c) {
                    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
                        parts.push((part as Record<string, unknown>).text as string);
                    }
                }
                text = parts.join("\n");
            } else {
                return undefined;
            }
            out.push({ role, text });
        }
        return out;
    } catch {
        return undefined;
    }
}

// #1309 per-session memory for auxiliary classification. WeakMap like
// orphan-gc's streaks — non-persisted, GC'd with the session object.
//
// `seen`: wire texts of the LAST request that ran the full pipeline ("last
// main-line view"), replaced wholesale each main turn (bounded by one view).
// `resendLatch`: set once when a main-line request re-sent at least one message
// verbatim from the previous main-line view. It is the discriminator between
// two request classes that are otherwise indistinguishable (≤2 fresh messages,
// no tools, same session key):
//   - auxiliary/synthetic overlays (auto-review, classifier, title-gen — the
//     #1307 storm), which only appear on session keys carrying a LIVE evolving
//     conversation whose turns re-send their history verbatim; and
//   - legitimate turns of stateless clients that never re-send history, which
//     must keep today's full-pipeline behavior (#1075 contract: a single
//     no-tools normal-budget request consumes one ref).
// Classification additionally requires the last main-line view to be at least
// AUXILIARY_MIN_MAIN_VIEW messages (see that constant). Until the latch is set,
// every request runs the full pipeline exactly as before — zero behavior change
// for sessions that have not demonstrated incremental resending.
type AnchorState = { known: Set<string>; resendLatch: boolean };
const anchorBySession = new WeakMap<object, AnchorState>();

function identityKey(role: string, text: string): string {
    return role + "\x00" + text;
}

/** Record a main-line request's view as the session's affinity anchor. Only
 *  qualifying views (≥ AUXILIARY_MIN_MAIN_VIEW messages) update it — tiny
 *  views never bootstrap or shrink the anchor (no anchor poisoning, #1309).
 *  The resend latch arms when a view re-sends ≥1 message verbatim from the
 *  previously recorded one (monotonic once set). */
export function recordAnchorView(session: Session, texts: WireTexts): void {
    if (texts.length < AUXILIARY_MIN_MAIN_VIEW) return;
    const prev = anchorBySession.get(session);
    const overlap = prev ? texts.some((t) => prev.known.has(identityKey(t.role, t.text))) : false;
    const known = new Set<string>();
    for (const t of texts) known.add(identityKey(t.role, t.text));
    anchorBySession.set(session, { known, resendLatch: (prev?.resendLatch ?? false) || overlap });
}

export function isAuxiliaryRequest(protocol: WireProtocol, parsed: unknown, session: Session): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    // #546 principle: a non-empty tools array marks an agent MAIN turn.
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    // No anchor or no demonstrated verbatim continuation → full pipeline
    // (fail-safe direction; #1075 stateless clients never arm the latch).
    const anchor = anchorBySession.get(session);
    if (!anchor || !anchor.resendLatch) return false;
    const incoming = extractWireTexts(protocol, parsed);
    if (!incoming || incoming.length === 0 || incoming.length > AUXILIARY_MAX_MESSAGES) return false;
    // Identity affinity: every incoming message unknown to the anchor view
    // (diverges at the first message) → side lane; any recognized message →
    // continuation (trim/edit/retry) → full pipeline.
    return incoming.every((t) => !anchor.known.has(identityKey(t.role, t.text)));
}
