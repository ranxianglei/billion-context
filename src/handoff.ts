import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { matchSession as matchSessionKernel } from "acp-kernel";
import type { CompressionState } from "acp-kernel";
import { renderForgedSummary } from "./codex-compact.js";
import { markDirty, type Session } from "./session.js";
import { SessionStore } from "./persist.js";

/**
 * Session handoff / rollover (#1539): long sessions keep resending their full
 * raw client history every turn (11699 msgs / 15.7MiB inbound observed) even
 * though bili keeps the upstream wire small. Rollover cuts that growth: the
 * user mints a token for the old session (`bili handoff <id>`), pastes it into
 * a NEW blank agent session, and the proxy clones the old session's ACP state
 * into the new one so compression continues where it left off.
 *
 * Minimal visible set (owner decision, #1539): the new session inherits ONLY
 * (a) the full messageRefs maps (hash→number, no content), (b) the active
 * blocks' summaries as a carrier text frozen at adoption time, and (c) a
 * derivedFromSessionId link back to the source. Blocks, blockContents and the
 * CCR store are deliberately NOT copied: cloned old blocks would be
 * deactivated by syncBlocks on turn 1 anyway (their anchors are absent from
 * the fresh history), and everything older stays reachable through the
 * existing #1333 ancestor-fallback chain (whole-block decompress,
 * search_context, foreign-session search, `bili export`). Deliberately NOT
 * inherited either: nudge, stats, tokenSnapshot, rules, absorbed,
 * terminalStreak — the context genuinely reset, so accounting starts fresh.
 *
 * Refs and block/run counters are copied WHOLESALE (not just the visible
 * ones): the assignRefs cursor is highestUsedIndex+1, so a partial copy would
 * let fresh assignments collide with the source's un-copied numbers and old
 * summaries citing mNNNNN would silently resolve to different messages
 * (violating the kernel's id-never-reused contract in substance). The same
 * collision logic applies to block ids (bNNN) and run ids cited inside
 * summaries — hence nextBlockId/nextRunId continue above the source's space
 * too, which also makes local decompress(<old block>) miss deterministically
 * and fall back to the ancestor instead of hitting a same-numbered new block.
 */

export const HANDOFF_TOKEN_VERSION = 1;

// base64url alphabet; payload length floor keeps accidental bracket text from
// matching, ceiling bounds decode cost.
export const HANDOFF_TOKEN_RE = /\[BILI_SESSION_HANDOFF v(\d+) ([A-Za-z0-9_-]{8,})\]/;

// Header-derived session ids are bounded; a hand-crafted oversized payload is
// malformed, not an id.
const MAX_DECODED_ID_LENGTH = 4096;

export function encodeHandoffToken(sessionId: string): string {
    if (!sessionId) throw new Error("handoff: empty session id");
    const payload = Buffer.from(sessionId, "utf8").toString("base64url");
    // Must match HANDOFF_TOKEN_RE's payload floor: a shorter payload would mint
    // a token findHandoffToken can never detect (silent adoption failure).
    if (payload.length < 8) {
        throw new Error("handoff: session id too short for a handoff token (needs at least 6 bytes)");
    }
    return `[BILI_SESSION_HANDOFF v${HANDOFF_TOKEN_VERSION} ${payload}]`;
}

// Strict decode: canonical base64url (no padding) that round-trips byte-exact.
// Buffer decodes leniently — the round-trip rejects padded/non-canonical or
// garbage payloads that happen to yield a printable string.
export function decodeHandoffPayload(payload: string): string | undefined {
    try {
        const id = Buffer.from(payload, "base64url").toString("utf8");
        if (!id || id.length > MAX_DECODED_ID_LENGTH) return undefined;
        if (Buffer.from(id, "utf8").toString("base64url") !== payload) return undefined;
        return id;
    } catch {
        return undefined;
    }
}

export interface HandoffTokenRef {
    /** The exact matched token text (per-turn substitution key). */
    token: string;
    sessionId: string;
}

/** Find the first valid handoff token in a text blob. Undefined when absent,
 *  wrong-version, or undecodable — callers fail open (token stays literal). */
export function findHandoffToken(text: string): HandoffTokenRef | undefined {
    const m = HANDOFF_TOKEN_RE.exec(text);
    if (!m) return undefined;
    if (Number(m[1]) !== HANDOFF_TOKEN_VERSION) return undefined;
    const sessionId = decodeHandoffPayload(m[2]!);
    if (!sessionId) return undefined;
    return { token: m[0], sessionId };
}

// Read per-request (not cached at startup) so a running proxy can flip the
// kill-switch without a restart (same pattern as codexCompactMode).
export function handoffEnabled(): boolean {
    return process.env.BILI_HANDOFF?.trim().toLowerCase() !== "pass";
}

// Blankness in the sense that matters for rollover: NO VALID chat/ACP state
// yet. stats.requests is deliberately NOT the gate — some clients issue side
// requests/probes before the first real user message; those leave no ACP
// state behind and must not disqualify the session. Conversely, any probe
// that DID assign refs or create blocks makes the target non-blank and is
// rejected conservatively (never adopt into a session that carries history).
export function isBlankForHandoff(state: CompressionState): boolean {
    return (
        state.blocks.length === 0 &&
        Object.keys(state.messageRefs.byRef).length === 0 &&
        Object.keys(state.tokenSnapshot).length === 0
    );
}

function blockNumber(blockId: string): number {
    return Number(blockId.replace(/\D/g, "")) || 0;
}

function highestRef(byRef: Record<string, string>): string {
    let max = "";
    let maxIdx = 0;
    for (const ref of Object.keys(byRef)) {
        const idx = Number(ref.replace(/\D/g, "")) || 0;
        if (idx > maxIdx) {
            maxIdx = idx;
            max = ref;
        }
    }
    return max;
}

/** The carrier text substituted in place of the pasted token, every turn, for
 *  the life of the target session. Built ONCE at adoption from the source's
 *  ACTIVE blocks (kernel render format — the model reads it exactly like a
 *  live kernel-rendered summary) and frozen into the target's metadata: the
 *  target carries no blocks of its own to rebuild from, and rebuilding from
 *  the source later would drift if the source keeps evolving. Deterministic
 *  ordering (block number ascending) keeps the substituted bytes — and thus
 *  the message's content hash — stable across turns. */
export function buildHandoffCarrier(sourceState: CompressionState, sourceId: string): string {
    const active = sourceState.blocks.filter((b) => b.active);
    active.sort((a, b) => blockNumber(a.blockId) - blockNumber(b.blockId));
    const maxRef = highestRef(sourceState.messageRefs.byRef);
    const parts: string[] = [
        `[bili] session handoff from ${sourceId}: ${active.length} compression block summar${active.length === 1 ? "y" : "ies"} inherited below; message and block numbering continue above the previous session's space${maxRef ? ` (refs up to ${maxRef})` : ""}`,
    ];
    for (const b of active) parts.push(renderForgedSummary(b));
    return parts.join("\n\n");
}

export type HandoffPlan =
    | {
          ok: true;
          carrier: string;
          refsCount: number;
          maxRef: string;
          nextBlockId: number;
          nextRunId: number;
          adoptedBlocks: number;
      }
    | { ok: false; reason: string };

/** Decide whether the source's state can be handed off into the target. Pure:
 *  reads both, mutates nothing. */
export function planHandoff(
    target: Pick<Session, "id" | "state" | "metadata">,
    sourceState: CompressionState,
    sourceId: string,
): HandoffPlan {
    if (target.id === sourceId) return { ok: false, reason: "target and source are the same session" };
    if (!isBlankForHandoff(target.state)) {
        return { ok: false, reason: "target already has ACP state (blocks/refs/token accounting); start a fresh session" };
    }
    if (target.metadata.handoffFrom) {
        return { ok: false, reason: `target already has a handoff from ${String(target.metadata.handoffFrom)}` };
    }
    if (target.metadata.derivedFromSessionId) {
        return { ok: false, reason: "target already derives from another session" };
    }
    const active = sourceState.blocks.filter((b) => b.active);
    if (active.length === 0) {
        return { ok: false, reason: "source has no active compression blocks; nothing to inherit (use bili export instead)" };
    }
    return {
        ok: true,
        carrier: buildHandoffCarrier(sourceState, sourceId),
        refsCount: Object.keys(sourceState.messageRefs.byRef).length,
        maxRef: highestRef(sourceState.messageRefs.byRef),
        nextBlockId: Math.max(target.state.nextBlockId, sourceState.nextBlockId),
        nextRunId: Math.max(target.state.nextRunId, sourceState.nextRunId),
        adoptedBlocks: active.length,
    };
}

/** Seed a blank target session from an approved plan. Copy-on-handoff: every
 *  value read from the source is merged/cloned; the source session is never
 *  touched. See the module header for WHAT is inherited and WHY each excluded
 *  piece stays out. */
export function applyHandoff(
    target: Session,
    plan: Extract<HandoffPlan, { ok: true }>,
    sourceState: CompressionState,
    sourceId: string,
    token: string,
): void {
    for (const [ref, raw] of Object.entries(sourceState.messageRefs.byRef)) {
        if (ref in target.state.messageRefs.byRef) continue;
        target.state.messageRefs.byRef[ref] = raw;
        target.state.messageRefs.byRaw[raw] = ref;
    }
    target.state.nextBlockId = Math.max(target.state.nextBlockId, plan.nextBlockId);
    target.state.nextRunId = Math.max(target.state.nextRunId, plan.nextRunId);
    target.metadata.handoffFrom = sourceId;
    target.metadata.derivedFromSessionId = sourceId;
    // Frozen at adoption: the per-turn substitution key (exact token text) and
    // the carrier bytes. Neither is ever recomputed afterwards.
    target.metadata.handoffToken = token;
    target.metadata.handoffCarrier = plan.carrier;
    markDirty(target);
}

export interface HandoffOptions {
    dir?: string;
    output?: string;
}

/** `bili handoff <selector>` — offline: resolves the persisted session,
 *  mints its rollover token. Mirrors exportSession's selector semantics. */
export async function handoffSession(selector: string | undefined, opts: HandoffOptions = {}): Promise<string> {
    const store = new SessionStore({ dir: opts.dir, enabled: true });
    const all = [...(await store.loadAll()).values()];
    if (all.length === 0) {
        throw new Error("no persisted sessions found (sessions are written under the sessions directory once the proxy has served a request)");
    }
    if (!selector) {
        const rows = all
            .map((s) => `${s.id}${s.meta.label ? `  label=${s.meta.label}` : ""}  blocks=${s.state.blocks.length}(active ${s.state.blocks.filter((b) => b.active).length})`)
            .join("\n  ");
        return ["Persisted sessions:", "", `  ${rows}`, "", 'Usage: bili handoff <session-id|label> [--output FILE]'].join("\n");
    }
    const matches = matchSessionKernel(all, selector, (s) => s.meta.label);
    if (matches.length === 0) {
        throw new Error(`no session matches "${selector}" (run "bili handoff" to list sessions)`);
    }
    if (matches.length > 1) {
        throw new Error(`selector "${selector}" matches ${matches.length} sessions (${matches.map((s) => s.id).join(", ")}); use the full session id`);
    }
    const s = matches[0]!;
    const active = s.state.blocks.filter((b) => b.active);
    if (active.length === 0) {
        throw new Error(`session ${s.id} has no active compression blocks — nothing to hand off (use "bili export ${selector}" for a markdown handoff doc instead)`);
    }
    const token = encodeHandoffToken(s.id);
    if (opts.output) {
        mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        writeFileSync(opts.output, token + "\n", "utf8");
        return `written to ${opts.output}\npaste the token into a NEW blank agent session to roll over`;
    }
    return [
        token,
        "",
        "Paste this token into a NEW blank agent session. On that session's first request the proxy clones the compression state (message/block numbering + active block summaries) into it; the old session keeps running untouched.",
    ].join("\n");
}
