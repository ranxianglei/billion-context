// #2944 v2: order-primary session resolution — on the WIRE-NEUTRAL domain.
//
// The general rule that retires the persona-fp ladder (owner rule,
// 2026-10-12):
//
//   1. 顺序 + sessionid(客户端自生成、无歧义)即可认领同一个会话,
//      绝对没有错误 —— 内容一个字不看。
//   2. 压缩锚点默认顺序位置,hash 只是参考(下层 #2939 order-centric
//      reconcile 同向)。
//   3. hash 用于防止压缩导致的漂移、subagent 复用主会话带来的漂移
//      —— 防错认护栏,不参与认领决策。
//   4. 不打膏药:一条通用规则,协议无关,不逐客户端特判。
//
// v2 substrate (the delta vs the first draft, see #2944 review): the
// skeleton is minted from `neutralTurns()` (src/affinity-neutral.ts, the
// #2791 wire-neutral projection that #2939 already runs on) — NOT from a
// new raw-field classifier. One source of protocol-shape knowledge, all
// four wires for free:
//
//   skeletonOf(messages) = neutralTurns(messages).map(t => t.kind)
//
//   - content-blind by construction (kind ∈ user|assistant|tool|raw|role)
//   - google `parts` and responses `function_call` items are first-class
//   - the LEADING system/developer run is stripped (host harness state
//     churn cannot misalign the skeleton — #1148 discipline)
//   - client synthetic marker turns ("[model changed: …]") are dropped
//   - image-capability placeholders (#2636) are dropped
//   - consecutive assistant messages merge, multi-block tool_results
//     split — so renderers that disagree on message packing agree on turns
//
// Guard rail (rule 3) — where ORDER alone is ambiguous. Two branches look
// order-identical for different truths, and content-fragment hashes (the
// projection's per-turn `frags`, content-derived but never consulted for
// CLAIMING) disambiguate without reading a byte of prose:
//
//   shorter-than-recorded + tail aligns:
//     genuine head truncation (dsh native compaction) keeps the old tail
//     MESSAGES verbatim → tail frags equal → raw + reanchor.
//     a codex-style subagent replay (#150: reuses the main
//     body.session_id, self-contained, alternating tail aligns easily)
//     carries DIFFERENT tail content → frags differ → derived, never raw.
//   grown + head diverged + tail aligns (head rewritten by a compaction
//     summary): same frag check — a summary head with the old tail passes;
//     a coincidentally tail-aligning stranger fails.
//
// Derived-task lanes are DISCRIMINATED by skeleton hash
// (`|sub:task:<skel8>`): different stranger shapes never share one
// compression session (two subagents under one main id stay separate),
// while the same stranger replaying across passes keeps a stable key.
//
// id provenance (接线时生效 — the caller contract; ids that fail it stay
// on the anonymous ladder, prefix-affinity, untouched):
//
//   lane        qualifies (client-minted, unambiguous)   falls back
//   anthropic   header (plugin conv / session header)    first-user content fp
//   openai      header                                    first-user content fp
//   responses   header | body.session_id | metadata.session_id
//                                                        previous_response_id (upstream-minted), content fp
//   google      header                                    content fp
//
//   (derived from conversationIdentityResponses' `clientProvided` axis —
//   kernel/src/wire/responses.ts — and the per-wire twins; a
//   content-fingerprint id is representation-derived and never qualifies.
//   NOTE for the wiring PR: the codex instructions-namespace
//   (SubagentNamespaces) and the anthropic #970 subagent split run
//   UPSTREAM of this resolver and stay — this module is the conversation
//   axis only.)
//
// This module is the NEW implementation, implemented ALONGSIDE
// src/persona-anchor.ts (the old ladder) — the old file is NOT deleted and
// the server is NOT switched over yet (see #2944 rollout). Both
// implementations are pinned by the same input/output corpus in
// tests/issue2944-neutral-skeleton.test.ts: behavior-compatible rows share
// one expectation; designed divergences are marked old→new per row.

import { createHash } from "node:crypto";
// The one cross-module consult in this otherwise-pure resolver: the
// persisted prefix-affinity chain (chainContinues, restart-race tiebreaker
// below). Safe against the aux-first race because the identified-session
// tracker's append-only discipline (#1075/#1486, src/server/handle.ts:1173)
// never lets a shallow side request clobber a deeper persisted entry.
import { prefixAffinity } from "./prefix-affinity.js";
import { isClaudeLaneToken } from "./claude-lane-token.js";
import { neutralTurns, type NeutralTurn } from "./affinity-neutral.js";
// #3397: skeleton persistence hook (deferred-use ESM cycle with
// src/order-persist.ts — each side calls the other only inside function
// bodies, never at module evaluation; see the note on its import).
import { scheduleOrderPersist } from "./order-persist.js";

const TAIL_WINDOW = 8;

/** Order skeleton: the per-turn KIND sequence of the wire-neutral
 *  projection. Content-blind by construction — only role/tool shape
 *  participates. */
export function orderSkeletonOf(messages: unknown): string[] {
    const list = Array.isArray(messages) ? (messages as unknown[]) : [];
    return neutralTurns(list).map((t) => t.kind);
}

/** Per-turn content-fragment fingerprints (rule-3 guard rail — never
 *  consulted for claiming, only to disambiguate order-ambiguous corners).
 *  #2791 projects the same logical content to the same fragments on every
 *  wire, so the guard is cross-wire stable. */
function fragsOf(turns: NeutralTurn[]): string[] {
    return turns.map((t) => (t.frags ?? [t.kind]).join("\u0001"));
}

const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);

function tailAligns(kinds: string[], recorded: string[]): boolean {
    const window = Math.min(TAIL_WINDOW, kinds.length, recorded.length);
    if (window === 0) return false;
    for (let i = 1; i <= window; i++) {
        if (kinds[kinds.length - i] !== recorded[recorded.length - i]) return false;
    }
    return true;
}

/** A main conversation has assistant turns and at least a few cells; an
 *  aux persona (dsh auto-review: one flattened user blob) has neither.
 *  This is the ONLY aux/persona discriminator — no system text, no content
 *  hash, no per-client special case. */
function mainShaped(kinds: string[]): boolean {
    if (kinds.length < 3) return false;
    return kinds.some((k) => k === "assistant");
}

const skel8 = (kinds: string[]): string =>
    createHash("sha256").update(kinds.join("\u0000")).digest("hex").slice(0, 8);

/** #4778: harness-state roles carry per-turn HOST state (date, budget,
 *  model banner — dsh NEXT stamps a DIFFERENT system prompt on every turn
 *  and rewrites prior ones in its own log on goal continuations) and zero
 *  conversation identifying power. */
const HARNESS_ROLES = new Set(["system", "developer"]);

/** #4778: longest run of CONSECUTIVE same-index content-fragment agreements
 *  between two skeletons, compared over CONVERSATION CELLS ONLY — the
 *  harness-state cells are excluded from both sequences BEFORE alignment,
 *  because the host inserts/removes/empties them around its own bookkeeping
 *  and must not shift the content-cell alignment. Exact per-cell sha256
 *  comparison — no fuzzy similarity (MESSAGE-IDENTITY doctrine); a run of
 *  CONTINUATION_MIN_RUN agreements is cryptographically impossible between
 *  two distinct conversations. */
function maxAlignedFragRun(kindsA: string[], fragsA: string[], kindsB: string[], fragsB: string[]): number {
    const fa: string[] = [];
    const fb: string[] = [];
    for (let i = 0; i < fragsA.length; i++) if (!HARNESS_ROLES.has(kindsA[i])) fa.push(fragsA[i]);
    for (let j = 0; j < fragsB.length; j++) if (!HARNESS_ROLES.has(kindsB[j])) fb.push(fragsB[j]);
    const n = Math.min(fa.length, fb.length);
    let best = 0;
    let cur = 0;
    for (let i = 0; i < n; i++) {
        cur = fa[i] === fb[i] ? cur + 1 : 0;
        if (cur > best) best = cur;
    }
    return best;
}

/** #4778: minimum same-index agreement run proving that a tag-changed
 *  history is the SAME conversation with host-side edits, not a stranger. */
const CONTINUATION_MIN_RUN = 8;

// #5719 E5: the #3733 authored-checkpoint identity header, as FORGED by
// src/server/dsh-authored-compaction.ts (BILI_SNAPSHOT_TAG_PREFIX). Pinned
// locally instead of imported: this module must stay server-free (the wiring
// direction is handle.ts → here), and the version-pin doctrine
// (src/server/dsh-compaction-guard.ts header) wants detector constants local.
// If the producer's bytes drift the scan degrades to a MISS — the pre-#5719
// fork behavior — never to a false claim.
const BILI_SNAPSHOT_CONV_RE = /\x3cbili-snapshot v1 [^\x3e]*\bconv="([^"]+)"/;

/** #5719 E5: does the FIRST user message carry our own authored-checkpoint
 *  identity header declaring exactly `rawId`? A full compaction erases every
 *  continuation proof the tag-changed rungs demand by definition (recorded
 *  tail gone, depth collapsed, zero assistant in the first post-compaction
 *  step) — the self-declaration is the one survivor. Content-blind text
 *  extraction over all four wire shapes (string content; parts/blocks arrays
 *  with .text items — openai/anthropic/responses/google alike). Only the
 *  first user message counts: a LATER quote of a checkpoint (the #4438
 *  class) must never re-anchor someone else's lane. */
function selfCheckpointDeclares(history: unknown, rawId: string): boolean {
    if (!Array.isArray(history)) return false;
    for (const m of history as unknown[]) {
        if (m === null || typeof m !== "object") continue;
        const msg = m as { role?: unknown; content?: unknown; parts?: unknown };
        if (msg.role !== "user") continue;
        const c = msg.content !== undefined ? msg.content : msg.parts;
        let text = "";
        if (typeof c === "string") {
            text = c;
        } else if (Array.isArray(c)) {
            for (const p of c) {
                if (p !== null && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
                    text += (p as { text: string }).text;
                }
            }
        }
        const hit = BILI_SNAPSHOT_CONV_RE.exec(text);
        return hit !== null && hit[1] === rawId;
    }
    return false;
}

export type SessionOrderResolution = {
    key: string;
    action: "claim" | "continue" | "reanchor" | "derived-aux" | "derived-task" | "derived-persona";
    /** Human-readable reason for the derived/reanchor branches (log surface). */
    reason?: string;
};

type Recorded = { kinds: string[]; frags: string[]; tagHash: string; model?: string; lastSeen: number };

/** #3397: persona-tag identity is carried by its sha256 (the raw text can be
 *  tens of KB of host system prompt; the persisted snapshot must not carry it
 *  and the resolver only ever compares tags for equality). "" = non-anchoring. */
const tagHashOf = (tag: string): string =>
    tag === "" ? "" : createHash("sha256").update(tag, "utf8").digest("hex");

/** Order skeletons. #3397: no longer process-memory-only — every mutation is
 *  debounced-persisted (src/order-persist.ts) and hydrated on boot, so a
 *  restart can no longer re-run the cold-start claim race that flipped the
 *  main conversation's key across boots and orphaned its compression state. */
const skeletons = new Map<string, Recorded>();

/** Persisted form of a recorded skeleton (src/order-persist.ts wire shape). */
export interface OrderSkeletonEntry {
    id: string;
    kinds: string[];
    frags: string[];
    tagHash: string;
    model?: string;
    lastSeen: number;
}

function record(rawId: string, turns: NeutralTurn[], tagHash: string, model?: string): void {
    skeletons.set(rawId, { kinds: turns.map((t) => t.kind), frags: fragsOf(turns), tagHash, model, lastSeen: Date.now() });
    scheduleOrderPersist();
}

/** #2944 order-primary resolution. `rawId` MUST be a client-minted,
 *  unambiguous conversation id (caller's provenance contract — see the
 *  table above; ids that fail it stay on the anonymous ladder).
 *
 *  `personaTag` (optional, rule-3 guard): the persona-defining text the
 *  host stamps on this lane — dsh system text, codex instructions. Order
 *  claims; the tag only guards the lanes order alone cannot tell apart:
 *  a tag change on CONTINUING history (model switch / AGENTS.md edit —
 *  kinds prefix-align AND head fragments match) migrates the raw key
 *  (#2241/#2250); a tag change whose recorded body still sits verbatim at
 *  its own indices inside the incoming (host-side rewrite of its own log —
 *  #4778) migrates too; a tag change whose first user message carries our
 *  own authored checkpoint declaring exactly the raw id migrates outright
 *  (#5719 — full compaction erases every positional proof by definition,
 *  the self-declaration is the survivor); only a tag change with NO such
 *  evidence forks onto `<rawId>|sub:<fp16(tag)>` — byte-identical to the
 *  old ladder's fork keys, so persisted fork lanes keep their sessions
 *  across the upgrade.
 *
 *  `laneToken` (optional, #5095 D1-C): a bili-minted dispatch token carried
 *  on the wire (SubagentStart hook → additionalContext → the dispatch's
 *  first user message). When valid it outranks every heuristic: the key
 *  is `<rawId>|sub:<fp16(tag)>:t:<token>` deterministically, per DISPATCH —
 *  parallel same-persona dispatches (same system text, same fingerprint —
 *  the injectivity gap #5095 documents) land on distinct lanes, and a
 *  token'd request never claims or re-anchors the raw id.
 *
 *  `laneDiscriminator` (#5095 D1-B, optional): the fallback for wires
 *  WITHOUT a valid token (un-upgraded installs, hook disabled, post-fold
 *  head loss) — a per-run identity consumed by ONLY the derived-persona
 *  fork branch. The claude-anthropic header-less-subagent call site passes
 *  the dispatch's task prompt (first user message fragment): same-type
 *  subagents re-dispatched under one parent id share their system
 *  byte-for-byte, so (id, persona) alone is not injective over RUNS. A
 *  non-empty discriminator widens the fork key to
 *  `<rawId>|sub:<fp16(tag)>:<fp16(disc)>`; every other caller omits both
 *  optional args and keeps the byte-identical old ladder.
 *
 *  `msgIds` (#5719, second-to-last param for source compatibility): the
 *  host-stamped per-message id array riding the request (`biliMsgIds`, the
 *  #4491 pipeline — dsh's llm/stream waterfall mints a stable UUID per
 *  message and resends it unchanged across restarts and compactions). It
 *  adds ONE rung and nowhere else: at the FORK exits, when every byte-level
 *  escape was defeated because the host destroyed the evidence in the same
 *  turn it changed the system text (full compaction ∩ volatile-field drift —
 *  the #5517/#5719 composite field failure), ANY overlap between the
 *  incoming ids and the message ids RECORDED under this key in the UNIFIED
 *  STORE (the messages.msg_id column — #4491 pins these very ids at ingest,
 *  so there is NO parallel JSON ledger) proves the SAME conversation
 *  (host-minted random UUIDs cannot collide across distinct conversations)
 *  and the request re-anchors onto the raw lane instead of forking a
 *  zero-state `|sub:` child. Requests without stamped ids — or with an
 *  unavailable store view — take exactly the pre-change path.
 *
 *  `readStoredMsgIds` (#5719, LAST param): `(key) => readonly string[] | null`
 *  — the recorded msg_ids for a conversation key (production:
 *  getStore().unifiedAllMessageIds — #5312's full historical id set, live AND
 *  retired rows, identity-only with no content hydration). Invoked AT MOST
 *  once, and only at a fork exit with non-empty inbound ids; never on the
 *  hot path. null = store unavailable (latch-off / legacy epoch) →
 *  byte-evidence only.
 */
export function resolveSessionOrder(rawId: string, history: unknown, personaTag?: string, declaredModel?: string, laneToken?: string, laneDiscriminator?: string, msgIds?: string[], readStoredMsgIds?: (rawKey: string) => readonly string[] | null): SessionOrderResolution {
    const list = Array.isArray(history) ? (history as unknown[]) : [];
    const turns = neutralTurns(list);
    // #5719: normalize the incoming stamped ids ONCE (malformed/absent →
    // undefined — degrade over half-trust, the fork-exit rung below then
    // takes exactly the pre-change path).
    const inboundIds: string[] | undefined =
        msgIds !== undefined && msgIds.length > 0 && msgIds.every((s) => typeof s === "string" && s.trim().length > 0)
            ? msgIds
            : undefined;
    const kinds = turns.map((t) => t.kind);
    const incomingFrags = fragsOf(turns);
    const tag = personaTag !== undefined && personaTag.trim().length > 0 ? personaTag : "";
    const tagHash = tagHashOf(tag);
    const model = declaredModel !== undefined && declaredModel.trim().length > 0 ? declaredModel.trim() : undefined;
    if (isClaudeLaneToken(laneToken)) {
        // #5095 D1-C: deterministic birth claim. The token is unique per
        // subagent dispatch, so it needs no skeleton corroboration — record
        // the dispatch's own skeleton under its lane key and return. Same
        // token on every pass of one dispatch recomputes the same key; two
        // parallel dispatches of the SAME persona (identical tag hash — the
        // D1 merge) get distinct keys by construction.
        const laneKey = `${rawId}|sub:${tag !== "" ? `${fp16(tag)}:` : ""}t:${laneToken}`;
        record(laneKey, turns, tagHash, model);
        return { key: laneKey, action: "derived-persona", reason: "dispatch lane token — per-dispatch persona lane (#5095)" };
    }
    // #5095 D1-B fallback (no valid token on the wire): per-run fragment,
    // consumed below by the derived-persona fork branch only.
    const disc = laneDiscriminator !== undefined && laneDiscriminator.trim().length > 0 ? laneDiscriminator.trim() : "";
    const recorded = skeletons.get(rawId);
    if (recorded === undefined) {
        // First sight under the id. A main-shaped history claims the raw
        // key; a shallow history claims ONLY when it carries a persona tag
        // (the codex turn-1 shape: one user message + instructions — a real
        // main turn, indistinguishable from a review blob without the tag);
        // a tag-less shallow blob is an aux persona and NEVER claims — the
        // #1916 review-steals-raw race dies there without reading prose.
        // (Call sites never pass an empty tag in production — handle.ts routes
        // empty system/instructions verbatim (non-anchoring) — this branch is
        // library defense for direct callers: the corpus census lane.)
        if (!mainShaped(kinds) && tag === "") {
            return { key: `${rawId}|sub:aux`, action: "derived-aux", reason: "shallow history with no assistant turns" };
        }
        record(rawId, turns, tagHash, model);
        return { key: rawId, action: "claim" };
    }
    const fragTailEquals = (n: number): boolean => {
        const w = Math.min(TAIL_WINDOW, n);
        const a = incomingFrags.slice(-w);
        const b = recorded.frags.slice(-w);
        return a.length === b.length && a.every((f, i) => f === b[i]);
    };
    const tagChanged = tagHash !== "" && tagHash !== recorded.tagHash;
    // An EMPTY incoming tag (system-less / instructions-less request) is
    // the old ladder's non-anchoring path: it rides whatever the id holds
    // and never counts as a persona change.
    const effectiveTagHash = tagHash === "" ? recorded.tagHash : tagHash;
    const effectiveModel = model ?? recorded.model;
    /** Fork-exit last resort: host-minted msgids survive BOTH destructive
     *  forces (compaction deletes cells, system rewrite deletes fragments),
     *  so any overlap between the incoming ids and the rows recorded under
     *  THIS KEY in the unified store is proof of identity — re-anchor
     *  instead of forking a zero-state sub lane (#5719). The store lookup is
     *  LAZY (fires only here, with stamped ids present) and null-safe: a
     *  latched-off / legacy store degrades to the byte-evidence path. */
    const tryMsgIdRescue = (): SessionOrderResolution | null => {
        if (inboundIds === undefined || readStoredMsgIds === undefined) return null;
        const stored = readStoredMsgIds(rawId);
        if (stored === null || stored.length === 0) return null;
        const known = new Set(stored);
        let hits = 0;
        let firstHit = "";
        for (const s of inboundIds) {
            if (known.has(s)) {
                hits++;
                if (firstHit === "") firstHit = s;
            }
        }
        if (hits === 0) return null;
        record(rawId, turns, effectiveTagHash, effectiveModel);
        return {
            key: rawId,
            action: "reanchor",
            reason: `byte-level continuation failed but ${hits} host message id(s) match rows recorded for this key in the unified store (${firstHit}) — same conversation by sessionid+msgid identity (#5719)`,
        };
    };
    if (tagChanged) {
        // Persona guard (owner rule 3). Same id, different persona text:
        // keep raw ONLY with order AND content evidence — the kinds must
        // prefix-align the recorded skeleton AND the head fragments must
        // match (the host replayed the SAME conversation under a new
        // system/instructions: model switch / AGENTS.md edit). Anything
        // else is a different persona under the shared id (#150 fresh
        // task, #1916 auto-review): its own `|sub:<fp16(tag)>` lane,
        // stable across successive calls of the same persona.
        if (selfCheckpointDeclares(history, rawId)) {
            // #5719 E5 (first rung — strongest evidence, cheapest check): the
            // incoming carries bili's OWN authored checkpoint (#3733) whose
            // identity header declares this exact raw id. Full compaction
            // erases every continuation proof the rungs below demand by
            // definition, so no other evidence is demanded here — the marker
            // IS the proof. record() moves the recorded tagHash to the new
            // tag, so the next request is tag-unchanged and simply continues;
            // the `|sub:` fork never happens and the parent lane unfreezes.
            record(rawId, turns, tagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "self-authored checkpoint declares this raw id — continuation across full-compaction rewrite (#5719)" };
        }
        const headN = Math.min(kinds.length, recorded.kinds.length);
        const headAligns = headN > 0 && recorded.kinds.every((k, i) => kinds[i] === k);
        const headFragsEqual = headN > 0 && incomingFrags.slice(0, headN).every((f, i) => f === recorded.frags[i]);
        if (mainShaped(kinds) && headAligns && headFragsEqual) {
            record(rawId, turns, tagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "persona text changed on continuing history — anchor migrated (#2241/#2250)" };
        }
        if (
            mainShaped(kinds) && model !== undefined && recorded.model !== undefined && model !== recorded.model
        ) {
            // #2601/#2817: the persona text changed in the same window as a
            // host-declared model switch (x-bili-plugin-model names a
            // DIFFERENT model than the anchored claim) — the two host
            // declarations corroborate, so the switch absorbs (migrate) even
            // across a compacted/rewritten history whose fragments cannot
            // prove continuation. Without the header change this exact shape
            // still forks (the control case).
            record(rawId, turns, tagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "header-corroborated model switch — anchor migrated (#2601/#2817)" };
        }
        if (Array.isArray(history) && prefixAffinity.chainContinues(history, rawId)) {
            // Post-restart persona race (owner review of #2815, finding ①).
            // After a proxy restart the in-memory skeleton is cold and a
            // SHALLOW aux request (title/review — self-carried system text,
            // one user message) can claim the virgin raw id first; the main
            // conversation then arrives tagChanged with headAligns trivially
            // true (recorded is one user turn) and headFragsEqual false
            // (blob ≠ main user0) — without this rung it forks the main lane
            // off the raw key for the process lifetime (#2156 form). The
            // PERSISTED prefix-affinity chain is the tiebreaker: it holds the
            // pre-restart main prefix at full depth (the append-only
            // discipline kept the blob from clobbering it), and a history
            // whose neutral progressive hash at the stored depth equals the
            // stored tail hash is cryptographically the same conversation
            // continuing — migrate, exactly like the old #2241 ladder did.
            record(rawId, turns, tagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "persona text changed on a history that continues the raw key’s persisted chain — anchor migrated (post-restart persona race #2241/#2250)" };
        }
        if (
            mainShaped(kinds) &&
            kinds.length >= recorded.kinds.length &&
            maxAlignedFragRun(kinds, incomingFrags, recorded.kinds, recorded.frags) >= CONTINUATION_MIN_RUN
        ) {
            // #4778: the host rewrote PART of its own persisted history while
            // the persona text changed (dsh goal auto-continuation clears the
            // prior per-turn system messages; the cleared cells break BOTH the
            // head-fragment rung above and the byte-exact chain rung) — but
            // the recorded conversation still sits inside the incoming at its
            // own indices. A long same-index content-fragment agreement run
            // cannot occur between distinct conversations, so this is the
            // SAME conversation with host-side edits → migrate, never fork.
            // Both guards keep the #150/#1916 defenses intact: a self-
            // contained stranger under a reused id shares no positional
            // content (overlap ~0), and a STALE shorter replay must not
            // rewind the live skeleton (the length gate).
            record(rawId, turns, tagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "persona text changed but the recorded history continues inside the incoming — anchor migrated (#4778)" };
        }
        // #5686: fifth rung — the composite field failure behind the
        // |sub:-drift cluster (#5517/#5656 reports): a native-compaction
        // checkpoint LANDS (head cells replaced by one summary message) while
        // the host simultaneously rotates its per-turn system prompt (dsh NEXT
        // harness-state banners). The incoming is then SHORTER than the
        // recorded skeleton with tagChanged true, which defeats every rung
        // above (head fragments broken by the summary, no model switch, chain
        // depth insufficient, length gate false) and deterministically forks
        // the live lane onto <rawId>|sub:<fp16(tag)> — whose first visible
        // message is the checkpoint sentence itself. The fix is the exact
        // mirror of the tag-LESS shorter-reanchor below (same two tests, same
        // TAIL_WINDOW, no extra floor): a byte-identical fragment-verified
        // tail cannot belong to a different conversation (MESSAGE-IDENTITY).
        if (kinds.length > 0 && kinds.length < recorded.kinds.length && tailAligns(kinds, recorded.kinds) && fragTailEquals(kinds.length)) {
            record(rawId, turns, tagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "persona text changed but the shorter incoming keeps the recorded conversation's fragment-verified tail — head rewrite under a new system prompt, anchor kept (#5686)" };
        }
        // #5719: every byte-level escape needs EVIDENCE (fragments/cells/
        // chain continuity) that the composite field failure destroys in the
        // same turn — fall back to the only surviving identity carrier.
        const msgRescue = tryMsgIdRescue();
        if (msgRescue !== null) return msgRescue;
        // #5095 D1-B: a non-empty discriminator (only the claude-anthropic
        // headless-subagent call site passes one) widens the key into a
        // three-segment form so distinct same-type runs never share a
        // compression session; empty degrades to the two-segment key.
        const laneKey = disc !== "" ? `${rawId}|sub:${fp16(tag)}:${fp16(disc)}` : `${rawId}|sub:${fp16(tag)}`;
        record(laneKey, turns, tagHash, model);
        return { key: laneKey, action: "derived-persona", reason: "persona text changed without continuing history — persona lane" };
    }
    if (!mainShaped(kinds)) {
        // Shallow traffic under the claimed id rides the raw key — with a
        // persona tag it is the old ladder's fp-equal behavior (the persona
        // owns the id); tag-less it is the old non-anchoring path (a
        // system-less auxiliary call rides whatever the id holds). The
        // #1916 review-steals-raw protection lives one branch up: real
        // aux personas (dsh review, title) carry a DIFFERENT tag and fork
        // onto their own lane before reaching here; the strict |sub:aux
        // branch protects only VIRGIN ids (nothing to steal once claimed).
        record(rawId, turns, effectiveTagHash, effectiveModel);
        return { key: rawId, action: "continue" };
    }
    if (kinds.length >= recorded.kinds.length) {
        if (recorded.kinds.every((k, i) => kinds[i] === k)) {
            record(rawId, turns, effectiveTagHash, effectiveModel);
            return { key: rawId, action: "continue" };
        }
        if (tailAligns(kinds, recorded.kinds) && fragTailEquals(Math.min(kinds.length, recorded.kinds.length))) {
            // Grown (or equal), prefix diverged, tail aligned AND the tail
            // fragments match: the host rewrote the head (native compaction
            // summary / re-anchored event log) while keeping the living
            // tail verbatim. Trust the id, re-anchor the skeleton.
            record(rawId, turns, effectiveTagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "order tail aligned and tail fragments match, head rewritten" };
        }
        if (tag !== "") {
            // Same persona, diverged order: the persona owns the id (owner
            // rule 1 — id+persona 认领), so the skeleton follows the living
            // end. The strict task-lane guard below is for tag-less and
            // cross-persona callers, where id trust has no persona
            // corroboration (#150 subagent replay).
            record(rawId, turns, effectiveTagHash, effectiveModel);
            return { key: rawId, action: "reanchor", reason: "same persona id, diverged order — skeleton follows the living end" };
        }
        // Deep main-shaped history sharing nothing with the recorded
        // skeleton on an unambiguous id: the guard rail (owner rule 3) —
        // derived, never the raw key, until the skeleton is re-established.
        // The skeleton-hash discriminator keeps distinct strangers (two
        // subagents under one main id) on distinct compression sessions.
        const taskRescue = tryMsgIdRescue();
        if (taskRescue !== null) return taskRescue;
        return { key: `${rawId}|sub:task:${skel8(kinds)}`, action: "derived-task", reason: "no order+fragment alignment with the recorded skeleton" };
    }
    // Shorter than recorded: either head truncation (dsh native compaction
    // keeps the old tail messages verbatim → fragments equal → raw +
    // re-anchor, the living end follows the host's truth) or an id-reuse
    // replay (#150 codex subagent: self-contained, tail aligns by
    // alternation) whose tail content is DIFFERENT → derived-task.
    if (tailAligns(kinds, recorded.kinds) && fragTailEquals(kinds.length)) {
        record(rawId, turns, effectiveTagHash, effectiveModel);
        return { key: rawId, action: "reanchor", reason: "truncated head, tail aligned and fragment-verified" };
    }
    if (tag !== "") {
        // Same persona, shorter, not a verbatim suffix: persona owns the
        // id (old ladder's fp-equal rescue shape — a shrunken replay under
        // the anchor system keeps the raw key).
        record(rawId, turns, effectiveTagHash, effectiveModel);
        return { key: rawId, action: "reanchor", reason: "same persona id, shorter replay — skeleton follows the living end" };
    }
    const shortRescue = tryMsgIdRescue();
    if (shortRescue !== null) return shortRescue;
    return {
        key: `${rawId}|sub:task:${skel8(kinds)}`,
        action: "derived-task",
        reason: "shorter history with a divergent tail — id-reuse guard (subagent replay?)",
    };
}

/** Diagnostic/test surface: the recorded skeleton for an id. */
export function sessionOrderSkeletonOf(rawId: string): string[] | undefined {
    return skeletons.get(rawId)?.kinds;
}

export function resetSessionOrderForTest(): void {
    skeletons.clear();
}

/** #3397: persisted-snapshot surface (src/order-persist.ts wire shape). */
export function orderSnapshot(): OrderSkeletonEntry[] {
    return [...skeletons.entries()].map(([id, r]) => ({ id, kinds: r.kinds, frags: r.frags, tagHash: r.tagHash, model: r.model, lastSeen: r.lastSeen }));
}

/** Merge a hydrated snapshot: per-id newer lastSeen wins. Returns imported count. */
export function applyOrderSnapshot(entries: OrderSkeletonEntry[]): number {
    let imported = 0;
    for (const e of entries) {
        const cur = skeletons.get(e.id);
        if (!cur || e.lastSeen > cur.lastSeen) {
            skeletons.set(e.id, { kinds: e.kinds, frags: e.frags, tagHash: e.tagHash, model: e.model, lastSeen: e.lastSeen });
            imported++;
        }
    }
    return imported;
}

/** handle.ts wiring adapter (replaces personaNamespace at the dsh /
 *  codex-instructions / claude-responses persona sites): same contract —
 *  raw id + the request's history in, the conversation key out. The old
 *  ladder consumed (systemText, model) and keyed by system-hash; the v2
 *  resolver is content-blind and keys by order+id with fragment guards,
 *  so those parameters are simply gone.
 *
 *  `msgIds` (#5719) and `readStoredMsgIds` (#5719) are deliberately the LAST
 *  parameters so every existing call site stays source-compatible; pass the
 *  validated `biliMsgIds` array (src/msgid-pin.ts `incomingMsgIdsOf`) plus
 *  the unified-store msg_id lookup so the fork-exit rung can prove identity
 *  by sessionid+msgid when the byte-level evidence was destroyed in the same
 *  turn (#5517 compound failure). The lookup is invoked lazily, at most once. */
/** #5686 visibility seam (optional): observers of state-changing outcomes.
 *  Production used to discard everything but the key, so every fork
 *  (derived-*) and migration (reanchor) ran with zero durable trace — the
 *  drift cluster had to be reverse-engineered from field screenshots. Claim
 *  and continue stay silent (steady-state volume); the caller decides what
 *  to log. The callback is best-effort: a throwing observer must never break
 *  resolution. */
type SessionResolveObserver = (rawId: string, r: SessionOrderResolution) => void;

export function personaConversationOrder(rawId: string, history: unknown, personaTag?: string, declaredModel?: string, laneToken?: string, laneDiscriminator?: string, onResolve?: SessionResolveObserver, msgIds?: string[], readStoredMsgIds?: (rawKey: string) => readonly string[] | null): string {
    const res = resolveSessionOrder(rawId, history, personaTag ?? "", declaredModel, laneToken, laneDiscriminator, msgIds, readStoredMsgIds);
    if (onResolve !== undefined) {
        try {
            onResolve(rawId, res);
        } catch {
            // observer hook — diagnostics only
        }
    }
    return res.key;
}
