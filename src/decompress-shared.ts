import {
    collectBlockContent,
    markBlockRestoredInline,
    parseBoundary,
    retrieveByRef,
    retrievedMessageId,
    type CompressionBlock,
    type CompressionCore,
    type CompressionState,
    type Config,
    type CoreMessage,
    type InlineRestoreResult,
} from "acp-kernel";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { markDirty, preCompactionArchiveOf, peekSession, findSessionByCanonicalId, type Session } from "./session.js";
import { getStore } from "./persist.js";
import { ccrEnabled, contentStoreOf } from "./store.js";

/** Bounded retention for large-decompress temp files. Each decompress with
 *  body > 10000 writes one file under tmpdir(); the reaper unlinks oldest past
 *  BILI_DECOMPRESS_TMP_CAP (default 50) and beforeExit cleans all. */
type TrackedTempFile = { path: string; mtimeMs: number };
const trackedTempFiles: TrackedTempFile[] = [];

function getDecompressTmpCap(): number {
    const raw = process.env.BILI_DECOMPRESS_TMP_CAP;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

function reapTempFiles(): void {
    const cap = getDecompressTmpCap();
    while (trackedTempFiles.length > cap) {
        trackedTempFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
        const oldest = trackedTempFiles.shift();
        if (!oldest) break;
        try {
            unlinkSync(oldest.path);
        } catch {}
    }
}

process.on("beforeExit", () => {
    for (const f of trackedTempFiles) {
        try {
            unlinkSync(f.path);
        } catch {}
    }
    trackedTempFiles.length = 0;
});

/** Shared ctx shape used by both the chat and responses compress loops. */
export type ProxyToolCtx = {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    /** Unfolded original history. Loop paths hand the folded view as
     *  `messages`; decompress's cache-miss fallback must scan this instead. */
    compressMessages?: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
};

/** Resolve a decompress request to a result string, honoring the `full` flag
 *  and the cross-round original-content cache on the session.
 *
 *  STATELESS RETRIEVAL: decompress is copy-paste — the block stays active, the
 *  forwarded view keeps folding, the cache is kept (repeat decompresses are
 *  free), and there is no expand/re-fold cycle. The one exception is the
 *  inline whole-block path, which additionally flags the block restoredInline
 *  so a later compress may refold it in place (#1294 P2 / kernel K2) — a
 *  sidecar flag only; ids and refs never move.
 *
 *  - If the block has cached originals (captured at compress time), use the
 *    cached `one` or `full` view per the flag. This is the cross-round-safe
 *    path: ctx.messages only holds the folded view by the time decompress runs.
 *  - Otherwise fall back to collectBlockContent against the unfolded view
 *    (ctx.compressMessages ?? ctx.messages); if that yields nothing, return
 *    the block summary. */
export function resolveDecompress(
    args: Record<string, unknown>,
    ctx: ProxyToolCtx,
): string {
    const rawBlockId = args.blockId;
    if (typeof rawBlockId !== "string" || rawBlockId.length === 0) {
        return "[decompress FAILED: blockId is required]";
    }
    const blockId = rawBlockId.trim();
    const block = ctx.core.decompress(blockId, ctx.session.state);
    if (!block) return resolveDerivedDecompress(args, ctx, blockId);
    const archived = preCompactionArchiveOf(ctx.session);
    if (archived[blockId] !== undefined) {
        return `[decompress FAILED: block ${blockId} is a pre-compaction archive — its content was in the history BEFORE the client's native compaction and is no longer reachable (replaced by the client's compaction summary). decompress is unavailable for archived blocks.]`;
    }
    if (typeof args.startId === "string" || typeof args.endId === "string") {
        return resolveDecompressRange(args, ctx, block);
    }

    const full = args.full === true;
    const cached = ctx.session.blockContents.get(blockId);
    let body: string;
    let count: number;
    if (cached) {
        // Honor the full flag: `one` = direct msgs + nested child summaries,
        // `full` = all original messages. Returning the cached full text
        // unconditionally would break the default one-level semantics.
        // `one === null` means the two views were byte-identical at cache
        // time and deduped to one copy (#401).
        const view = full ? cached.full : (cached.one ?? cached.full);
        body = view.text;
        count = view.count;
    } else {
        const collected = collectBlockContent(ctx.session.state, block, ctx.compressMessages ?? ctx.messages, { full });
        body = collected.text || block.summary;
        count = collected.count;
    }

    const header = `[Block ${blockId} content — ${count} item(s)${full ? ", full" : ""}]`;
    const safeBlockId = blockId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const outPath = body.length > 10000 ? join(tmpdir(), `acp-decompress-${safeBlockId}-${Date.now()}.txt`) : null;
    if (outPath) {
        try {
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 });
            trackedTempFiles.push({ path: outPath, mtimeMs: Date.now() });
            reapTempFiles();
            return `${header}\nContent (${body.length} chars) written to: ${outPath}\nUse the read tool to access it.`;
        } catch (e) {
            return `${header}\n[Failed to write to ${outPath}: ${String(e)}]\n${safePrefix(body, 4000)}...`;
        }
    }
    // #398/#403 + #1294 P2 wiring (dedup of #1316 × #1298): a successful INLINE
    // whole-block restore hands the block's re-summarization material back to
    // the model via this tool result, and the client keeps tool results in its
    // re-sent history — flag restoredInline so a later compress refolds the
    // block in place (kernel K2) instead of bouncing off "already
    // compressed". The toFile path above returns BEFORE this point and stays
    // byte-identical to pre-refold behavior (no flag, no hint — the material
    // lives in a temp file, not the conversation). Range restores
    // (startId/endId) return partial content and never reach here; inactive
    // blocks can never refold.
    if (!block.active) return `${header}\n${body}`;
    // The kernel result is idempotent — a repeat restore recomputes the same
    // span, so the hint stays byte-identical across repeats (old contract:
    // repeat decompress returns identical content). Only the FIRST restore
    // pays the state write + persist.
    const marked = markBlockRestoredInline(ctx.session.state, blockId);
    if (block.restoredInline !== true) {
        ctx.session.state = marked.state;
        markDirty(ctx.session);
        ctx.log(`[acp-decompress-inline] ${blockId}: flagged restoredInline${marked.result?.restoredStartRef ? ` (${marked.result.restoredStartRef}–${marked.result.restoredEndRef})` : ""}`);
    }
    return `${header}\n${body}\n\n${refoldHint(blockId, marked.result)}`;
}

// #1294 P2: close the loop on an inline restore — kernel K2 updates the
// inline-restored block IN PLACE when re-compressed (same id, replaced
// summary) instead of rejecting "already compressed". Degrades to a generic
// hint when the kernel could not derive exact refs (e.g. multi-segment span).
function refoldHint(blockId: string, result: InlineRestoreResult | null): string {
    if (result !== null && result.restoredStartRef && result.restoredEndRef) {
        return `Re-fold: call compress("${result.restoredStartRef}–${result.restoredEndRef}", <fresh summary>) → updates block ${blockId} in place (same id, new summary).`;
    }
    return `Re-fold: call compress over the restored messages with a fresh summary → updates block ${blockId} in place (same id, new summary).`;
}

type CoveredRefs = { raws: Array<{ raw: string; num: number }>; text: string };

function refNum(ref: string): number | null {
    const b = parseBoundary(ref);
    return b && b.kind === "message" ? b.numericId : null;
}

function coveredMessages(state: CompressionState, block: CompressionBlock): CoveredRefs | null {
    const byRaw = state.messageRefs.byRaw;
    const raws: Array<{ raw: string; num: number }> = [];
    for (const raw of block.effectiveMessageIds) {
        const ref = byRaw[raw];
        if (!ref) continue;
        const num = refNum(ref);
        if (num === null) continue;
        raws.push({ raw, num });
    }
    if (raws.length === 0) return null;
    raws.sort((a, z) => a.num - z.num);
    const runs: Array<[number, number]> = [];
    for (const { num } of raws) {
        const last = runs[runs.length - 1];
        if (last && num === last[1] + 1) last[1] = num;
        else runs.push([num, num]);
    }
    const fmtRun = ([a, z]: [number, number]) => (a === z ? `m${String(a).padStart(5, "0")}` : `m${String(a).padStart(5, "0")}–m${String(z).padStart(5, "0")}`);
    const head = runs.slice(0, 5);
    const shownCount = head.reduce((n, [a, z]) => n + (z - a + 1), 0);
    const rest = raws.length - shownCount;
    return { raws, text: head.map(fmtRun).join(", ") + (rest > 0 ? ` …+${rest} more` : "") };
}

/** #1179 CCR v2: the message refs a block covers, as compact span text
 *  ("m00044–m00097") plus count — or null when no individual refs are
 *  resolvable (older blocks whose raw ids left the map). */
export function coveredRefSpan(state: CompressionState, block: CompressionBlock): { text: string; count: number } | null {
    const cov = coveredMessages(state, block);
    return cov ? { text: cov.text, count: cov.raws.length } : null;
}

// #1179 CCR v2: range-level restore — return ONLY the block's messages whose
// refs fall within [startId, endId]. The content rides the ephemeral retrieval
// channel: ack now, full text queued as a request-only injection (same id/role
// shape as acp_retrieve injections, structurally excluded from fold space),
// never cached in blockContents. Gated on CCR being armed for the session.
function resolveDecompressRange(args: Record<string, unknown>, ctx: ProxyToolCtx, block: CompressionBlock): string {
    const startRaw = typeof args.startId === "string" ? args.startId.trim() : "";
    const endRaw = typeof args.endId === "string" ? args.endId.trim() : "";
    if (!startRaw || !endRaw) return "[decompress FAILED: startId and endId must be given together]";
    if (!ccrEnabled(ctx.session)) {
        // [#1207 review F3] Plugin mode structurally never arms CCR (the agent
        // owns its folds; bili never executes them) — the generic "enable
        // compress.ccr.enabled" advice is unsatisfiable there and would send
        // the model chasing a config that cannot help.
        if (typeof ctx.session.metadata.pluginAgent === "string") {
            return "[decompress FAILED: range restore (startId/endId) is proxy-mode only — plugin mode owns its folds natively]";
        }
        return "[decompress FAILED: range restore (startId/endId) requires CCR — enable compress.ccr.enabled]";
    }
    const sb = parseBoundary(startRaw);
    const eb = parseBoundary(endRaw);
    if (!sb || sb.kind !== "message" || !eb || eb.kind !== "message") {
        return `[decompress FAILED: startId/endId must be mNNNNN message refs (got "${startRaw}", "${endRaw}") — block ids (bN) are not valid here]`;
    }
    if (sb.numericId > eb.numericId) return `[decompress FAILED: startId ${startRaw} is after endId ${endRaw} — swap them]`;
    const state = ctx.session.state;
    const cov = coveredMessages(state, block);
    if (!cov) return `[decompress FAILED: ${block.blockId} has no per-message coverage recorded (older block) — use plain decompress {blockId} for the whole block]`;
    const pickedSet = new Set(cov.raws.filter(({ num }) => num >= sb.numericId && num <= eb.numericId).map(({ raw }) => raw));
    if (pickedSet.size === 0) return `[decompress FAILED: ${block.blockId} covers no messages in ${startRaw}–${endRaw} (its coverage is ${cov.text})]`;
    const parts: string[] = [];
    let restoredFromStore = 0;
    // [#1283] Per-ref source selection supersedes the all-or-nothing fallback
    // ([#1207 review F1]): store entries are immutable originals (append-only,
    // first write wins, refs never reissued), so the store wins whenever it has
    // the ref and the exec-time view is only the fallback (pre-CCR folds have
    // no entries). The old zero-items gate assumed view/store mutual exclusion
    // per ref that nothing enforces — a covered ref left visible in the view
    // contributed its view text, which for arrival-stored refs is the 📦
    // placeholder, not the original, and a partially visible span silently
    // dropped the missing refs. Iterating coverage in num order keeps the span
    // deterministic across both sources.
    const store = contentStoreOf(ctx.session);
    const viewById = new Map<string, CoreMessage>();
    for (const m of ctx.compressMessages ?? ctx.messages) {
        if (pickedSet.has(m.id)) viewById.set(m.id, m);
    }
    for (const { raw, num } of cov.raws) {
        if (!pickedSet.has(raw)) continue;
        const r = retrieveByRef(store, `m${String(num).padStart(5, "0")}`);
        if (r.ok) {
            parts.push(r.entry.toolName ? `[${r.entry.toolName} • stored]\n${r.text}` : `[${r.entry.kind} • stored]\n${r.text}`);
            restoredFromStore++;
            continue;
        }
        const m = viewById.get(raw);
        if (!m) continue;
        parts.push(m.toolName && m.contentType !== "text" ? `[${m.role} • ${m.toolName}]\n${m.text ?? ""}` : `[${m.role}]\n${m.text ?? ""}`);
    }
    if (parts.length === 0) {
        return `[decompress FAILED: originals for ${startRaw}–${endRaw} are neither in this request's view nor in the content store (pre-CCR fold) — whole-block decompress may still work from cache]`;
    }
    const header = `[Block ${block.blockId} content — ${startRaw}–${endRaw} — ${parts.length} item(s)]`;
    let injText: string;
    const body = parts.join("\n\n");
    if (body.length > 10000) {
        const safeBlockId = block.blockId.replace(/[^a-zA-Z0-9_-]/g, "-");
        // [#1207 review F4] Span in the filename (two spans of one block in the
        // same millisecond must not clobber each other) and 0600 (folded
        // conversation content is not world-readable on multi-user hosts).
        const outPath = join(tmpdir(), `acp-decompress-${safeBlockId}-${startRaw}-${endRaw}-${Date.now()}.txt`);
        try {
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 });
            trackedTempFiles.push({ path: outPath, mtimeMs: Date.now() });
            reapTempFiles();
            injText = `${header}\nContent (${body.length} chars) written to: ${outPath}\nUse the read tool to access it.`;
        } catch (e) {
            injText = `${header}\n[Failed to write to ${outPath}: ${String(e)}]\n${safePrefix(body, 4000)}...`;
        }
    } else {
        injText = `${header}\n${body}`;
    }
    // [#1207 review F5] A client retry re-executes this path; the injection id
    // is deterministic, so dedupe on it — retries re-ack without queueing a
    // duplicate full-text message or inflating rangeRestores.
    const injId = retrievedMessageId(`range_${block.blockId}_${startRaw}-${endRaw}`);
    if (!ctx.session.pendingRetrievals.some((p) => p.ref === injId)) {
        ctx.session.pendingRetrievals.push({ ref: injId, tokens: 0, chars: body.length, queuedAt: Date.now(), ccr: false, injection: { id: injId, role: "system", contentType: "text", text: injText } });
        ctx.session.stats.rangeRestores = (ctx.session.stats.rangeRestores ?? 0) + 1;
    }
    markDirty(ctx.session);
    ctx.log(`[acp-decompress-range] ${block.blockId} ${startRaw}–${endRaw}: restored ${parts.length} item(s)${restoredFromStore ? ` (${restoredFromStore} from content store)` : ""} via ephemeral injection`);
    return `[decompress ${block.blockId} ${startRaw}–${endRaw}: restored ${parts.length} item(s) — full content follows]`;
}

// Back off a cut that lands between the two halves of a surrogate pair, so the
// truncated prefix never ends on a lone high surrogate (#816: strict-UTF-8
// gateways 500 deterministically on re-encoded request bodies).
function safePrefix(text: string, n: number): string {
    let cut = Math.min(n, text.length);
    if (cut > 0 && cut < text.length) {
        const c = text.charCodeAt(cut - 1);
        if (c >= 0xD800 && c <= 0xDBFF) cut -= 1;
    }
    return text.slice(0, cut);
}

/** Shared search_context execution for all wire paths. Distinguishes "no active
 *  blocks at all" (searching is pointless until compress runs — an explicit
 *  message stops premature-search retry loops, #714) from "blocks exist but none
 *  matched". */
// #1333: read-only fallback for explicitly derived sessions (pi RLM child:
// the plugin reported its parent at register and the server recorded the
// link in metadata.derivedFromSessionId). Local miss → walk the parent chain
// (depth cap 8, cycle-guarded), resident-or-disk. Ancestor state is never
// mutated: no restoredInline flag, no cache write, no markDirty.
const DERIVED_CHAIN_MAX_DEPTH = 8;

export function derivedAncestorSessions(session: Session): Session[] {
    const out: Session[] = [];
    const seen = new Set<string>([session.id]);
    let cursor: Session = session;
    while (out.length < DERIVED_CHAIN_MAX_DEPTH) {
        const nextId: unknown = cursor.metadata.derivedFromSessionId;
        if (typeof nextId !== "string" || nextId.length === 0 || seen.has(nextId)) break;
        seen.add(nextId);
        const next: Session | undefined = peekSession(nextId) ?? getStore().loadSync(nextId) ?? undefined;
        if (!next) break;
        out.push(next);
        cursor = next;
    }
    return out;
}

function resolveDerivedDecompress(
    args: Record<string, unknown>,
    ctx: ProxyToolCtx,
    blockId: string,
): string {
    for (const anc of derivedAncestorSessions(ctx.session)) {
        const block = ctx.core.decompress(blockId, anc.state);
        if (!block) continue;
        if (preCompactionArchiveOf(anc)[blockId] !== undefined) {
            return `[decompress FAILED: block ${blockId} is a pre-compaction archive in derived session ${anc.id} — its content was replaced by the client's compaction summary and is no longer reachable.]`;
        }
        if (typeof args.startId === "string" || typeof args.endId === "string") {
            return `[decompress FAILED: range restore (startId/endId) of derived-parent blocks is not supported — decompress "${blockId}" without range args (#1333)]`;
        }
        const full = args.full === true;
        const cached = anc.blockContents.get(blockId);
        const view = cached ? (full ? cached.full : (cached.one ?? cached.full)) : undefined;
        const body = view?.text || block.summary;
        const count = view?.count ?? 0;
        const header = `[Block ${blockId} content — ${count} item(s)${full ? ", full" : ""} · read-only from derived session ${anc.id} (#1333)]`;
        return `${header}\n${body}`;
    }
    return `[Block ${blockId} not found]`;
}

export function executeSearchContext(
    args: Record<string, unknown>,
    core: CompressionCore,
    state: CompressionState,
    foreignSessionId?: string,
): string {
    const query = typeof args.query === "string" ? args.query : "";
    if (query.length === 0) return "[search_context FAILED: query is required]";
    const scope = foreignSessionId ? ` in session ${foreignSessionId}` : "";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    const blocks = core.search(query, state).slice(0, limit);
    if (blocks.length === 0) {
        if (!state.blocks.some((b) => b.active)) return `[No compressed blocks exist yet${scope} — nothing to search.]`;
        return `[No blocks matched "${query}"${scope}]`;
    }
    const lines = blocks.map((b) => {
        const topic = b.topic ?? "(no topic)";
        const preview = b.summary.length > 200 ? safePrefix(b.summary, 200) + "..." : b.summary;
        // #1179 CCR v2: covered message-ref span(s) — connect block space to
        // store space so the model can target acp_retrieve / range decompress
        // at individual messages instead of whole blocks.
        const span = coveredRefSpan(state, b);
        const spanNote = span ? ` [${span.text} · ${span.count} msgs]` : "";
        return `${b.blockId} (T${b.tier}) "${topic}"${spanNote}\n  ${preview}`;
    });
    const note = foreignSessionId
        ? `\n\n[Read-only search of historical session ${foreignSessionId}. Block ids are per-session namespaces — decompress acts on the current session only. For bulk content use bili export ${foreignSessionId} [--full].]`
        : "";
    return `Found ${blocks.length} block(s) for "${query}"${scope}:\n\n${lines.join("\n\n")}${note}`;
}

// #841: resolve a requested session id to its compression state without
// touching it — resident memory first (verbatim id or canonical alias), then
// the persisted store. Never creates, reloads or marks anything dirty.
export function resolveForeignSessionState(id: string): CompressionState | null {
    const resident = peekSession(id) ?? findSessionByCanonicalId(id);
    if (resident) return resident.state;
    return getStore().loadStateForSearch(id);
}

export function executeSearchContextTarget(
    args: Record<string, unknown>,
    core: CompressionCore,
    sessionId: string,
    state: CompressionState,
): string {
    const requested = typeof args.conversation_id === "string" ? args.conversation_id.trim() : "";
    // #1125: honor the param description's "Defaults to the current conversation" —
    // the literal "current" (any case) resolves to this session, not the foreign lookup.
    if (!requested || requested === sessionId || requested.toLowerCase() === "current") {
        const local = executeSearchContext(args, core, state);
        // #1333: a derived session (pi RLM child) has no blocks of its own —
        // fall back to the recorded parent chain (read-only) instead of a
        // bare "nothing to search".
        if (local.startsWith("[No compressed blocks exist yet") || local.startsWith('[No blocks matched "')) {
            const self2 = peekSession(sessionId);
            if (self2) {
                for (const anc of derivedAncestorSessions(self2)) {
                    if (!core.search(String(args.query ?? ""), anc.state).length) continue;
                    return executeSearchContext(args, core, anc.state, anc.id);
                }
            }
        }
        return local;
    }
    // A self-reference under an alias form (canonical pfa-* id) keeps plain
    // current-session semantics — no "historical session" framing.
    const self = peekSession(requested) ?? findSessionByCanonicalId(requested);
    if (self?.id === sessionId) return executeSearchContext(args, core, state);
    const foreign = resolveForeignSessionState(requested);
    if (!foreign) return `[search_context FAILED: unknown session "${requested}"]`;
    return executeSearchContext(args, core, foreign, requested);
}
