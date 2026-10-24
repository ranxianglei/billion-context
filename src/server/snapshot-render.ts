import type { BiliMessage } from "acp-kernel/wire";
import { getStore } from "../persist.js";
import { featureEnabled } from "../rollout.js";
import { listSessions, type Session } from "../session.js";
import { loadConfigFile } from "../config.js";
import { resolveSnapshotShadow } from "../knobs.js";
import { createHash } from "node:crypto";

/**
 * #3756 snapshot render: assemble the outbound message view for a proxy
 * request from the server-side canonical transcript instead of re-deriving
 * message identity from the client-resent bytes.
 *
 * Doctrine (issue #3756, m-tier design): the (sessionId, unified snapshot)
 * pair IS the conversation; the client's resent history is an alignment
 * observation. Concretely:
 *
 *   - prefix authority: the unified transcript rows (core-form, fold-time
 *     message ids). Once a row exists, the outbound byte for it never
 *     changes — codec/identity upgrades re-mint client ids every turn but
 *     rows keep the ids the kernel assigned at fold time (#3752 becomes a
 *     non-event: refs/tags stay stable, the upstream cache prefix holds).
 *   - tail authority: the client's live messages — everything the client
 *     sent that the transcript has not yet recorded (this turn's fresh
 *     user message, the previous reply before it is re-observed) ride the
 *     client's own bytes.
 *   - alignment: a contiguous backward chain from the client's end against
 *     the transcript view (id fast path, then the #3658 canonical identity
 *     signature — role|contentType|toolName|text — so an upgrade turn where
 *     every id is re-minted still chains by content).
 *   - client head edits (checkpoints, deletions, compactions of the head)
 *     never resurrect or duplicate rows: the prefix renders what the server
 *     has, the chain's first unmatched client message starts the tail, and
 *     anything below the chain is dropped (server-authoritative head).
 *   - rewinds truncate the transcript view at the chain join: rows the
 *     client no longer vouches for (beyond the last chained row) do not
 *     render — the tail is client-authoritative past the join point.
 *
 * The merged view keeps kernel semantics untouched downstream: covered rows
 * ride fold-time ids so prune strips them by effectiveMessageIds and renders
 * the real summaries; a synthetic anchor (acp_summary_<blockId>) is inserted
 * past each block's covered region so collectSummaryAnchors resolves it at
 * a deterministic position even when every covered row is outside the view.
 *
 * Inactive (rollout off / no active blocks / store unavailable / empty or
 * unchainable transcript / any parse failure) ⇒ returns the client view
 * unchanged — the legacy path, never a guess.
 */

/** Client-tail walk budget. Full-resend histories are bounded by the wire;
 *  beyond this the lane degrades rather than scanning unbounded tails. */
const MAX_CHAIN_WALK = 8192;

/** #3812: a seam is only accepted after at least this many CONSECUTIVE chain
 *  matches. The identity signature has no id component, so a single sig hit
 *  proves nothing — "继续"/yes/1 repeated later in the conversation would
 *  otherwise chain against the old copy and silently truncate everything
 *  between them. Two consecutive matches is the minimum evidence that a real
 *  seam (not a same-text collision) was found — the same discipline as
 *  MIN_RESYNC_RUN in fold-reconcile (there 3, because reconcile matches on
 *  position alone; here the second consecutive match must ALSO line up with
 *  the view, which a stray duplicate cannot provide). */
import { sha256Hex } from "../storage/store.js";

const MIN_SEAM_RUN = 2;

/** #3658 canonical identity signature minus the hash: the tuple the kernel
 *  derives message ids from. Equal signature ⇒ same logical message even
 *  when the id bytes were re-minted by an upgrade. Image cores share the
 *  "[image]" text, so the sidecar length rides the signature (same image ⇒
 *  same bytes ⇒ same length; different images practically always differ). */
function identitySig(m: BiliMessage): string {
    const text = typeof m.text === "string" ? m.text : "";
    // #4390: hash the image BYTES, never the length — same-size screenshots
    // used to collide and chain a false seam (silent truncation). The walk
    // only touches the tail region, so per-request hashing is bounded; a
    // 24-hex prefix is far beyond collision reach for seam evidence.
    const img = m.imagePart === true ? `|img:${sha256Hex(m.imageBase64 ?? "").slice(0, 24)}` : "";
    return `${m.role}|${m.contentType}|${m.toolName ?? ""}|${text}${img}`;
}

/** Test seam (#4390): the seam fingerprint under test — see identitySig. */
export function identitySigForTest(m: BiliMessage): string {
    return identitySig(m);
}

interface ViewRow {
    seq: number;
    msgId: string;
    /** Present only for UNCOVERED rows — covered rows' bytes never ride the
     *  outbound (suppressed behind anchors), so the windowed loader (#D5-5)
     * never reads them. */
    msg?: BiliMessage;
}

interface SnapshotRenderDeps {
    sessionId: string;
    /** #3812: plugin lanes are client-authoritative by design (the plugin
     *  contract carries the host's own history management — divert paths,
     *  incremental turns). They bypass this engine entirely: no render, no
     *  degrade marker, nothing observed. */
    pluginMode?: boolean;
    log?: (level: string, msg: string) => void;
}

/** One-time + per-turn observability: the latch counts active renders; the
 *  activated flag logs exactly once per session. */
function noteRender(session: Session, deps: SnapshotRenderDeps): void {
    const prior = typeof session.metadata["snapshotRenderTurns"] === "number" ? (session.metadata["snapshotRenderTurns"] as number) : 0;
    session.metadata["snapshotRenderTurns"] = prior + 1;
    if (prior === 0) deps.log?.("info", `[snapshot-render] active: outbound prefix now rendered from the unified transcript (issue #3756)`);
}

/** Post-arm degrade marker (observability only — never touches outbound bytes).
 *  Set here, cleared on a successful render. Pre-arm exits (rollout off / nothing
 *  armed) must NOT route through this: an unrendered lane is not a degradation. */
function legacyFor(session: Session, deps: SnapshotRenderDeps, clientMsgs: BiliMessage[], reason: string): BiliMessage[] {
    session.metadata["snapshotRenderDegradeReason"] = reason;
    deps.log?.("debug", `[snapshot-render] legacy fallback (${reason})`);
    return clientMsgs;
}

function parseRow(content: string, seq: number): BiliMessage | null {
    try {
        const parsed = JSON.parse(content) as { id?: unknown; role?: unknown };
        if (typeof parsed.id !== "string" || typeof parsed.role !== "string") return null;
        const msg = parsed as BiliMessage;
        // #4316 layer 3: the row's (session, seq) is the message's permanent
        // ledger position — stamp it so assignRefs issues the ref as the
        // direct display of the seq (never re-minted across byte churn).
        // Store seqs are 0-based; the ref display space is 1-based
        // (MIN_INDEX=1, "m00001" is the first number) — the stamp carries the
        // DISPLAY index. Rows written before this change simply lack the
        // field; the kernel counter path keeps serving them unchanged.
        msg.ledgerSeq = seq + 1;
        return msg;
    } catch {
        return null;
    }
}

/**
 * Returns the merged view, or `clientMsgs` unchanged when the lane is
 * inactive/degraded. Pure with respect to the transcript: the only mutations
 * are two observability fields on `session.metadata` (the render latch and the
 * last post-arm degrade reason) — neither touches outbound bytes.
 */
// tailStart (#4241): the first CLIENT index of the live tail (clientJoin) —
// everything in clientMsgs at indices >= tailStart rides the outbound verbatim,
// everything below is server-rendered territory. Exposed so the egress judge can
// exempt the rendered prefix and validate only the tail it promises byte-intact.
type ViewResult = { ok: true; view: BiliMessage[]; tailStart: number } | { ok: false; reason: string };

function buildView(session: Session, clientMsgs: BiliMessage[]): ViewResult {
    const activeBlocks = session.state.blocks.filter((b) => b.active);
    if (activeBlocks.length === 0) return { ok: false, reason: "no-active-blocks" };
    const store = getStore();
    if (!store) return { ok: false, reason: "store-unavailable" };
    // #D5-5 windowed load — two tiers:
    //   (a) identity rows (seq + msg_id, no bytes) for EVERY live row —
    //       positions and ids drive block anchoring and the byId seam chain;
    //   (b) content rows (bytes + media) ONLY for seqs OUTSIDE the covered
    //       intervals — covered rows are suppressed behind anchors, so their
    //       bytes never ride the outbound and are never read. A covered row
    //       with corrupt bytes therefore cannot degrade the render.
    let rows: ViewRow[] = [];
    try {
        const light = store.unifiedMessageIdRows(session.id);
        const seqs = store.unifiedTailSeqs(session.id);
        if (!light || light.length === 0 || !seqs || seqs.length === 0) return { ok: false, reason: "transcript-empty" };
        const bySeq = new Map<number, ViewRow>();
        for (const row of light) bySeq.set(row.seq, { seq: row.seq, msgId: row.msgId });
        for (const seq of seqs) {
            const v = bySeq.get(seq);
            if (!v) return { ok: false, reason: "view-pointer-missing-row" }; // view pointer to a missing row: degrade
            rows.push(v);
        }
    } catch {
        return { ok: false, reason: "transcript-error" };
    }
    if (rows.length === 0) return { ok: false, reason: "transcript-empty" };

    // #4052: the covered-region map must exist BEFORE the chain — the signature
    // fallback must not offer covered rows as bind targets (see the bySig filter
    // below). Per-block covered seqs seed from effectiveMessageIds (exact
    // fold-time ids; upgrade twins are re-keyed by reconcile, NOT swept by
    // signature here — #3812: the old sig sweep could not distinguish an upgrade
    // twin from a genuine later duplicate of the same text and silently swallowed
    // real messages).
    const blockSeeds: { blockId: string; seqs: Set<number> }[] = [];
    const coveredSeqUnion = new Set<number>();
    for (const block of activeBlocks) {
        const blockSeqs = new Set<number>();
        const wanted = new Set(block.effectiveMessageIds);
        for (let i = 0; i < rows.length; i++) {
            if (wanted.has(rows[i].msgId)) blockSeqs.add(rows[i].seq);
        }
        // #3812: no fold-time id resolves against the view — the block cannot
        // be positioned (and its covered region cannot be bounded). Anchoring
        // it at the top (the old behavior) renders the summary above raw
        // history the engine can no longer suppress. Degrade to the legacy
        // path, which renders the client view untouched.
        if (blockSeqs.size === 0) return { ok: false, reason: "block-unanchored" };
        for (const seq of blockSeqs) coveredSeqUnion.add(seq);
        blockSeeds.push({ blockId: block.blockId, seqs: blockSeqs });
    }

    // #D5-5: merge the covered seqs into disjoint intervals and load bytes
    // only for the uncovered window. Row-unparsable now guards UNCOVERED
    // bytes only — covered corruption cannot degrade the render.
    try {
        const intervals: [number, number][] = [];
        {
            const sorted = [...coveredSeqUnion].sort((a, b) => a - b);
            for (const seq of sorted) {
                const last = intervals[intervals.length - 1];
                if (last && seq <= last[1] + 1) last[1] = Math.max(last[1], seq);
                else intervals.push([seq, seq]);
            }
        }
        const contentRows = store.unifiedUncoveredRows(session.id, intervals);
        if (contentRows !== null) {
            const bySeq = new Map<number, ViewRow>();
            for (const row of contentRows) {
                const msg = parseRow(row.content, row.seq);
                if (!msg) return { ok: false, reason: "row-unparsable" }; // uncovered bytes are untrustworthy: degrade, never guess
                bySeq.set(row.seq, { seq: row.seq, msgId: row.msgId, msg });
            }
            let coveredSeen = 0;
            for (const r of rows) {
                const v = bySeq.get(r.seq);
                if (v) r.msg = v.msg;
                else if (coveredSeqUnion.has(r.seq)) coveredSeen++;
            }
            // Every row must be accounted for: uncovered-with-bytes or
            // covered. A gap (a row neither loaded nor covered — e.g. a
            // concurrent ingest raced the two queries) falls back to one full
            // load rather than rendering a hole.
            if (coveredSeen !== [...coveredSeqUnion].filter((seq) => rows.some((r) => r.seq === seq)).length || rows.some((r) => !r.msg && !coveredSeqUnion.has(r.seq))) {
                const full = store.unifiedTailViewRows(session.id);
                if (full !== null) {
                    const fullBySeq = new Map<number, BiliMessage>();
                    for (const row of full) {
                        const msg = parseRow(row.content, row.seq);
                        if (msg) fullBySeq.set(row.seq, msg);
                    }
                    for (const r of rows) {
                        if (!r.msg) {
                            const m = fullBySeq.get(r.seq);
                            if (!m && !coveredSeqUnion.has(r.seq)) return { ok: false, reason: "row-unparsable" };
                            if (m) r.msg = m;
                        }
                    }
                }
            }
        }
    } catch {
        return { ok: false, reason: "transcript-error" };
    }

    // Backward chain: from the client's end, match view rows (id fast path,
    // then identity signature). The chain must be contiguous; the first
    // unmatched client message bounds the client tail.
    let joinRow = -1; // view index of the TOPMOST matched row — the join point
    let clientJoin = clientMsgs.length; // first client index of the tail
    {
        const byId = new Map<string, number>(); // msgId -> view index (last occurrence)
        for (let i = 0; i < rows.length; i++) byId.set(rows[i].msgId, i);
        const bySig = new Map<string, number[]>(); // sig -> descending view indices
        for (let i = rows.length - 1; i >= 0; i--) {
            // #4052: covered rows take no signature binds. They never render
            // (the engine replaces them with anchors), so binding onto one buys
            // nothing for the view — it only moves the join past the bound
            // message, which erases its content when the message is genuinely
            // NEW (a fresh role|type|text collision with a folded row: the
            // latest message vanished from the view). An upgrade twin of a
            // covered row simply loses its bind: the chain breaks at the
            // covered region's top edge, the join stays at the boundary, and
            // the covered region still rides the prefix behind its anchor —
            // never loss, at worst a bounded degrade. byId keeps covered rows:
            // an exact id is unambiguous (kernel contract: ids never reused)
            // and steady-state seams need it.
            if (coveredSeqUnion.has(rows[i].seq)) continue;
            const m = rows[i].msg;
            if (!m) continue;
            const sig = identitySig(m);
            const list = bySig.get(sig);
            if (list) list.push(i);
            else bySig.set(sig, [i]);
        }
        let cursor = rows.length; // exclusive upper bound: matched rows must sit below this
        let started = false;
        let run = 0; // #3812: consecutive matched messages since the chain started
        let gapped = false; // #3812: one tolerated unmatched message (the reply lag)
        for (let k = clientMsgs.length - 1; k >= 0 && clientMsgs.length - 1 - k < MAX_CHAIN_WALK; k--) {
            const m = clientMsgs[k];
            const sig = identitySig(m);
            let hit = -1;
            const byIdHit = byId.get(m.id);
            if (byIdHit !== undefined && byIdHit < cursor) hit = byIdHit;
            else {
                const cands = bySig.get(sig);
                if (cands) {
                    for (const idx of cands) {
                        if (idx < cursor) {
                            hit = idx;
                            break; // cands are descending: first below cursor is the nearest
                        }
                    }
                }
            }
            if (hit < 0) {
                // Before the chain starts, unmatched messages are the live
                // tail (this turn's fresh user message, last turn's reply
                // not yet re-observed) — skip them. Once the chain has
                // started, ONE unmatched message is tolerated — the reply
                // lag: the client's second-to-last message is regularly the
                // previous turn's reply, which has no row yet (rows come
                // from what the client RE-SENT, and a retry/resent turn
                // carries it below an already-observed question). A second
                // consecutive unmatched message ends the chain (contiguity).
                if (started) {
                    if (gapped) break;
                    gapped = true;
                    continue;
                }
                continue;
            }
            gapped = false;
            if (!started) {
                started = true;
                clientJoin = k + 1; // tail = everything above the topmost matched message
                joinRow = hit; // the join point: the prefix renders every row up to and including it
            }
            run++;
            cursor = hit;
        }
        if (!started) return { ok: false, reason: "chain-not-started" }; // nothing chains: epoch-like rewrite, legacy
        // #3812: a lone match — however it matched — is not a seam. The classic
        // shape: the client's new "继续" chains by signature against an old
        // "继续" row while the true history sits above the old row's position;
        // accepting it renders only the ancient prefix + the one tail message
        // and silently drops everything between. Degrade instead: never guess.
        if (run < MIN_SEAM_RUN) return { ok: false, reason: "seam-too-short" };
    }
    const d = joinRow + 1; // prefix = rows[0..d) — everything up to the join; rows beyond (rewound-away tails) never render

    // Anchor synthesis: one anchor per active block, positioned past the
    // block's covered region in the transcript (first view row whose seq
    // exceeds this block's deepest covered row; end-of-prefix when none).
    // Per-block covered seqs come from the seeds computed before the chain
    // (#4052). A partially re-keyed block may leave a few twin rows rendering
    // alongside the summary (bounded duplicate content, visible, never loss);
    // that residual is the price of never guessing.
    const anchors: { at: number; msg: BiliMessage }[] = [];
    for (const { blockId, seqs: blockSeqs } of blockSeeds) {
        let maxCover = -1;
        for (const seq of blockSeqs) maxCover = Math.max(maxCover, seq);
        let at = d;
        for (let i = 0; i < d; i++) {
            if (rows[i].seq > maxCover) {
                at = i;
                break;
            }
        }
        anchors.push({
            at,
            msg: { id: `acp_summary_${blockId}`, role: "system", contentType: "text", text: "" } as BiliMessage,
        });
    }
    anchors.sort((a, b) => a.at - b.at);

    // The ENGINE owns coverage on this lane: covered rows never render —
    // prune's effectiveMessageIds strip cannot be trusted here because
    // reconcile may have re-keyed the block to the client's re-minted ids
    // (#3752 upgrade turns), while the transcript rows keep fold-time ids.
    // The synthesized anchor above carries each block's summary instead.
    const merged: BiliMessage[] = [];
    let ai = 0;
    for (let i = 0; i < d; i++) {
        while (ai < anchors.length && anchors[ai].at === i) merged.push(anchors[ai++].msg);
        if (coveredSeqUnion.has(rows[i].seq)) continue;
        const m = rows[i].msg;
        if (!m) return { ok: false, reason: "row-unparsable" }; // uncovered row without bytes: never render a hole
        merged.push(m);
    }
    while (ai < anchors.length) merged.push(anchors[ai++].msg);
    for (let k = clientJoin; k < clientMsgs.length; k++) merged.push(clientMsgs[k]);

    // #4241 tailStart is recorded in VIEW domain: the judge indexes its
    // baseline (judgeBaseline === this rendered view) with it, so it must
    // count the view rows that precede the first tail row. The client-domain
    // join (clientJoin) is NOT a valid index into the view — the view prefix
    // suppressed covered rows, so clientJoin can point past the view's end and
    // the judge would validate nothing (vacuous clean — the regression that
    // blinded the #4241 teeth on the T1-consolidation train).
    const tailCount = clientMsgs.length - clientJoin;
    return { ok: true, view: merged, tailStart: merged.length - tailCount };
}

export function maybeSnapshotView(session: Session, clientMsgs: BiliMessage[], deps: SnapshotRenderDeps): BiliMessage[] {
    // #4241: the judge reads this to know whether THIS turn's outbound prefix is
    // server-rendered. Clear unconditionally so presence ⟺ this call rendered a
    // live view — every early-return / degrade / shadow path leaves it unset,
    // which is exactly when the outbound is raw client bytes (legacy I1/I2 applies).
    delete session.metadata["snapshotRenderTailStart"];
    if (deps.pluginMode) return clientMsgs; // plugin lane: client-authoritative by design, not a degradation
    const live = featureEnabled("snapshotRender");
    const shadow = !live && shadowLaneEnabled();
    if (!live && !shadow) return clientMsgs;
    // Pre-arm (no folded block yet) is not observable and not a degrade: skip.
    if (!session.state.blocks.some((b) => b.active)) return clientMsgs;
    const r = buildView(session, clientMsgs);
    if (live) {
        if (!r.ok) return legacyFor(session, deps, clientMsgs, r.reason);
        delete session.metadata["snapshotRenderDegradeReason"];
        session.metadata["snapshotRenderTailStart"] = r.tailStart;
        noteRender(session, deps);
        return r.view;
    }
    noteShadow(session, deps, r, clientMsgs);
    return clientMsgs; // shadow NEVER changes outbound bytes
}

// ---------------------------------------------------------------------------
// Shadow observability (#3756 follow-up): classify the would-be view against
// what the legacy path actually sends. The classes are MECHANICAL — no
// heuristics; every error class is a provable set/logic violation.
// ---------------------------------------------------------------------------

function shadowLaneEnabled(): boolean {
    return resolveSnapshotShadow(process.env, loadConfigFile().snapshot?.shadow);
}

interface ShadowClassifyInput {
    view: BiliMessage[];
    clientMsgs: BiliMessage[];
    coveredClientIds: ReadonlySet<string>;
    prev?: { inputDigest?: string; viewDigest?: string };
}

interface ShadowClassify {
    lostTail: number;
    duplicateIds: string[];
    unstablePrefix: boolean;
    suppressed: number;
    inputDigest: string;
    viewDigest: string;
}

export function classifyShadowForTest(x: ShadowClassifyInput): ShadowClassify {
    const digest = (msgs: BiliMessage[]): string =>
        createHash("sha256").update(msgs.map((m) => `${m.id}\u0000${identitySig(m)}`).join("\u0001")).digest("hex").slice(0, 16);
    const isAnchor = (m: BiliMessage): boolean => typeof m.id === "string" && m.id.startsWith("acp_summary_");
    const viewIds = new Set<string>();
    const viewSigCount = new Map<string, number>();
    const idCount = new Map<string, number>();
    for (const m of x.view) {
        if (isAnchor(m)) continue;
        viewIds.add(m.id);
        idCount.set(m.id, (idCount.get(m.id) ?? 0) + 1);
        const sig = identitySig(m);
        viewSigCount.set(sig, (viewSigCount.get(sig) ?? 0) + 1);
    }
    let lostTail = 0;
    let suppressed = 0;
    for (const m of x.clientMsgs) {
        const inView = viewIds.has(m.id) || (viewSigCount.get(identitySig(m)) ?? 0) > 0;
        if (x.coveredClientIds.has(m.id)) {
            if (!inView) suppressed++; // expected fold suppression: info, never an error
            continue;
        }
        if (!inView) lostTail++; // a non-covered client message vanished from the would-be view
    }
    const duplicateIds = [...idCount.entries()].filter(([, c]) => c > 1).map(([id]) => id);
    const inputDigest = digest(x.clientMsgs);
    const viewDigest = digest(x.view);
    const unstablePrefix =
        x.prev?.inputDigest !== undefined && x.prev.inputDigest === inputDigest && x.prev.viewDigest !== undefined && x.prev.viewDigest !== viewDigest;
    return { lostTail, duplicateIds, unstablePrefix, suppressed, inputDigest, viewDigest };
}

interface ShadowBlob {
    turns: number;
    errors: number;
    lastClass: "watch" | "degraded" | "error";
    lastReason?: string;
    lastErrors?: string[];
    inputDigest?: string;
    viewDigest?: string;
    lastLogged?: string;
}

function noteShadow(session: Session, deps: SnapshotRenderDeps, result: ViewResult, clientMsgs: BiliMessage[]): void {
    const prior = session.metadata["snapshotShadow"];
    const blob: ShadowBlob =
        prior && typeof prior === "object" && typeof (prior as ShadowBlob).turns === "number"
            ? (prior as ShadowBlob)
            : { turns: 0, errors: 0, lastClass: "watch" };
    blob.turns++;
    if (!result.ok) {
        // Degrade classes (storage-off, seam-too-short, …) are KNOWN costs of
        // the conservative gates — the legacy outbound is what shipped, so
        // there is no would-be view to diff. Record the reason, never an error.
        blob.lastClass = "degraded";
        blob.lastReason = result.reason;
        delete blob.lastErrors;
        delete blob.inputDigest;
        delete blob.viewDigest;
        if (blob.lastLogged !== result.reason) {
            deps.log?.("warn", `[snapshot-shadow] view degraded on ${session.id} (${result.reason}) — legacy outbound kept`);
            blob.lastLogged = result.reason;
        }
        session.metadata["snapshotShadow"] = blob;
        return;
    }
    const covered = new Set<string>();
    for (const b of session.state.blocks) {
        if (!b.active) continue;
        for (const id of b.effectiveMessageIds) covered.add(id);
    }
    const c = classifyShadowForTest({
        view: result.view,
        clientMsgs,
        coveredClientIds: covered,
        prev: { inputDigest: blob.inputDigest, viewDigest: blob.viewDigest },
    });
    blob.inputDigest = c.inputDigest;
    blob.viewDigest = c.viewDigest;
    const errors: string[] = [];
    if (c.lostTail > 0) errors.push(`lost-tail:${c.lostTail}`);
    if (c.duplicateIds.length > 0) errors.push(`duplicate:${c.duplicateIds.length}`);
    if (c.unstablePrefix) errors.push("unstable-prefix");
    const signature = errors.length > 0 ? errors.join(",") : "ok";
    if (errors.length > 0) {
        blob.errors += errors.length;
        blob.lastClass = "error";
        blob.lastErrors = errors;
        delete blob.lastReason;
        if (blob.lastLogged !== signature) {
            deps.log?.("error", `[snapshot-shadow] mechanical mismatch on ${session.id} (${errors.join("; ")}) — diagnostics: /__bili/diagnostics?topic=snapshot-shadow`);
            blob.lastLogged = signature;
        }
    } else {
        blob.lastClass = "watch";
        delete blob.lastReason;
        delete blob.lastErrors;
    }
    session.metadata["snapshotShadow"] = blob;
}

interface SnapshotShadowWire {
    enabled: boolean;
    watching: number;
    errors: number;
    worst?: { sessionId: string; label?: string; lastErrors: string[] };
}

/** Aggregate across the live session pool for /__bili/status + the banner. */
export function snapshotShadowStatusWire(): SnapshotShadowWire {
    const enabled = shadowLaneEnabled();
    let watching = 0;
    let errors = 0;
    let worst: { sessionId: string; label?: string; lastErrors: string[]; n: number } | undefined;
    for (const s of listSessions()) {
        const blob = s.metadata["snapshotShadow"] as ShadowBlob | undefined;
        if (!blob || typeof blob !== "object" || !(blob.turns > 0)) continue;
        watching++;
        errors += blob.errors ?? 0;
        if ((blob.errors ?? 0) > 0 && (!worst || (blob.errors ?? 0) > worst.n)) {
            worst = { sessionId: s.id, label: s.meta.label !== s.id ? s.meta.label : undefined, lastErrors: blob.lastErrors ?? [], n: blob.errors ?? 0 };
        }
    }
    return enabled
        ? { enabled, watching, errors, ...(worst ? { worst: { sessionId: worst.sessionId, label: worst.label, lastErrors: worst.lastErrors } } : {}) }
        : { enabled, watching, errors };
}

