import {
    collectBlockContent,
    markBlockRestoredInline,
    matchToolMessagePattern,
    parseBoundary,
    retrieveByRef,
    retrievedMessageId,
    toolPathOf,
    type CompressionBlock,
    type CompressionCore,
    type CompressionState,
    type Config,
    type CoreMessage,
    type InlineRestoreResult,
} from "acp-kernel";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { markDirty, preCompactionArchiveOf, peekSession, findSessionByCanonicalId, type Session } from "./session.js";
import { getStore } from "./persist.js";
import { ccrEnabled, contentStoreOf } from "./store.js";
import { safePrefix } from "./text-safe.js";
import { decompressTmpCap as knobDecompressTmpCap } from "./knobs.js";
import { toolFail, toolOk, type ProxyToolResult } from "./proxy-tool-result.js";
import { describeRestorable } from "./image-restore.js";

/** Bounded retention for large-decompress temp files. Each decompress with
 *  body > 10000 writes one file under tmpdir(); the reaper unlinks oldest past
 *  BILI_DECOMPRESS_TMP_CAP (default 50) and beforeExit cleans all. */
type TrackedTempFile = { path: string; mtimeMs: number };
const trackedTempFiles: TrackedTempFile[] = [];

function getDecompressTmpCap(): number {
    return knobDecompressTmpCap();
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

/** #2204: classify a toFile target BEFORE touching the filesystem. Plain paths
 *  (POSIX, Windows drive letters `C:\x`/`c:/x`, UNC) go through path.resolve as
 *  before. A `scheme://` form whose scheme has ≥2 characters is a URI, not a
 *  path — single-letter "schemes" are drive letters, never URIs (`C://x` stays
 *  a path): `file://` resolves via fileURLToPath, every other scheme (host
 *  virtual files, e.g. OMP's `local://`) is refused up front. bili has no
 *  resolver for it and must not mkdir a directory named after its scheme. */
function resolveToFileTarget(target: string): { resolved?: string; refusal?: string } {
    const uri = target.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//);
    if (uri && uri[1]!.length >= 2) {
        const scheme = uri[1]!.toLowerCase();
        if (scheme === "file") {
            try {
                return { resolved: fileURLToPath(new URL(target)) };
            } catch (e) {
                return { refusal: `malformed file:// URI "${target}" (${String(e)})` };
            }
        }
        return { refusal: `unsupported virtual URI scheme "${scheme}" in toFile "${target}" — bili writes to the local filesystem only; pass an actual filesystem path (absolute, or relative to the proxy cwd) or a file:// URI` };
    }
    return { resolved: resolvePath(target) };
}

/** #2204: shared failure receipt for export paths. Starts with "[decompress
 *  FAILED:" so the wire loop's repeat-failure guard (loop/core.ts) and the
 *  plugin-mode success-header detection (plugin.ts) both read it as a failure;
 *  labels the preview as NOT a completed export, keeps the OS reason, and gives
 *  a recoverable retry. */
function exportFailureReceipt(path: string, err: unknown, body: string): ProxyToolResult {
    const preview = safePrefix(body, 4000);
    const scope = preview.length < body.length ? `partial content follows (${preview.length} of ${body.length} chars)` : "full content follows";
    return toolFail(
        `[decompress FAILED: could not write export to ${path}: ${String(err)}]\n` +
        `The export did NOT complete — ${scope}. Retry with a writable filesystem path, or omit toFile to restore inline.\n` +
        preview,
    );
}

/** #1691: honor the documented `toFile` argument. A non-empty string writes the
 *  restore to the caller's path regardless of body size (never inflates context;
 *  relative paths resolve against the proxy cwd). An explicit destination is an
 *  intentional artifact, so it is deliberately NOT pushed into trackedTempFiles —
 *  the reaper/beforeExit cleanup must never remove a file asked for by name.
 *  Returns null when toFile was omitted so the caller uses its default; otherwise
 *  a status-carrying result (#2204) — success pointer on write, toolFail receipt
 *  when the target is refused or the write fails. Never a bare string, so no
 *  caller can re-wrap a failure as toolOk. */
function toFilePointer(args: Record<string, unknown>, ctx: ProxyToolCtx, header: string, body: string): ProxyToolResult | null {
    const raw = args.toFile;
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") {
        ctx.log(`[acp-decompress] toFile must be a string (got ${typeof raw}) — using default output`);
        return null;
    }
    const target = raw.trim();
    if (target === "") return null;
    const t = resolveToFileTarget(target);
    if (t.refusal !== undefined) {
        ctx.log(`[acp-decompress] toFile refused before any file operation: ${t.refusal}`);
        return toolFail(`[decompress FAILED: ${t.refusal}]`);
    }
    const resolved = t.resolved!;
    try {
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, body, { encoding: "utf8", mode: 0o600 });
        return toolOk(`${header}\nContent (${body.length} chars) written to: ${resolved}\nUse the read tool to access it.`);
    } catch (e) {
        ctx.log(`[acp-decompress] toFile write failed: ${resolved} — ${String(e)}`);
        return exportFailureReceipt(resolved, e, body);
    }
}

// #5013: bodies above this ride the wire as a temp-file pointer, not bytes.
const INLINE_RESTORE_CHAR_CAP = 10000;

/** Auto-spill leg shared by every inline restore path (whole-block, range,
 *  derived-parent — the last used to skip it entirely, #5013). Under the cap
 *  the caller proceeds inline; over it the body lands in a tracked 0600 temp
 *  file (bounded retention via the reaper) and the caller gets a pointer — or
 *  the failure receipt when the write cannot happen. */
function autoSpillReceipt(header: string, body: string, fileTag: string): ProxyToolResult | null {
    if (body.length <= INLINE_RESTORE_CHAR_CAP) return null;
    const outPath = join(tmpdir(), `acp-decompress-${fileTag}-${Date.now()}.txt`);
    try {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 });
        trackedTempFiles.push({ path: outPath, mtimeMs: Date.now() });
        reapTempFiles();
        return toolOk(`${header}\nContent (${body.length} chars) written to: ${outPath}\nUse the read tool to access it.`);
    } catch (e) {
        return exportFailureReceipt(outPath, e, body);
    }
}

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
/** A decompress call asks for a range restore only when at least one range
 *  field carries a non-blank value (#1712). */
function hasRangeArgs(args: Record<string, unknown>): boolean {
    const start = typeof args.startId === "string" ? args.startId.trim() : "";
    const end = typeof args.endId === "string" ? args.endId.trim() : "";
    return start !== "" || end !== "";
}

export function resolveDecompress(
    args: Record<string, unknown>,
    ctx: ProxyToolCtx,
): ProxyToolResult {
    // #1995: image recovery is a distinct mode selected by a VALID imageRef — a
    // non-blank string (mNNNNN ref or "list"), independent of blockId/range,
    // intercepted first so an image-ref call never trips the blockId gate below.
    // #2626: key on a NON-BLANK VALUE, not field presence — hosts/models emit
    // ""/whitespace/null for optional fields, and presence-based dispatch hijacked
    // the text path (valid blockId + imageRef:"" returned the image-list receipt
    // instead of restoring the block). Blank/null/undefined ⇒ unspecified → fall
    // through to block/range restore; a non-string non-null value is a loud param
    // error, not a silent default to the image list.
    const ir = args.imageRef;
    if (ir != null && typeof ir !== "string") {
        return toolFail('[decompress FAILED: imageRef must be a string (an mNNNNN ref or "list") — omit it to restore a text block]');
    }
    if (typeof ir === "string" && ir.trim() !== "") {
        return resolveImageRestore(args, ctx);
    }
    const rawBlockId = args.blockId;
    if (typeof rawBlockId !== "string" || rawBlockId.length === 0) {
        return toolFail("[decompress FAILED: blockId is required]");
    }
    const blockId = rawBlockId.trim();
    const block = ctx.core.decompress(blockId, ctx.session.state);
    if (!block) {
        // Removed-from-state blocks (the #2695 reap path, or a future archive
        // that drops blocks) still carry their preCompactionArchive entry: fail
        // with the real reason instead of the misleading "not found" — the
        // model got here by citing a ref from a summary it legitimately saw.
        const selfArchived = preCompactionArchiveOf(ctx.session)[blockId];
        if (selfArchived !== undefined) {
            return toolFail(`[decompress FAILED: block ${blockId} is an archived block (${selfArchived.reason}) — it was removed from live state along with its covered substrate and cannot be restored.]`);
        }
        return resolveDerivedDecompress(args, ctx, blockId);
    }
    const archived = preCompactionArchiveOf(ctx.session);
    if (archived[blockId] !== undefined) {
        return toolFail(`[decompress FAILED: block ${blockId} is a pre-compaction archive — its content was in the history BEFORE the client's native compaction and is no longer reachable (replaced by the client's compaction summary). decompress is unavailable for archived blocks.]`);
    }
    // #1712: blank/whitespace range fields mean "unspecified" — hosts and models
    // emit "" for optional fields, and treating that as a range request produced
    // an unsatisfiable retry loop (fill in a real range → refused in plugin mode).
    if (hasRangeArgs(args)) {
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
    // #1336: retrieve-quality proxy — a whole-block restore where a precise
    // path existed (per-message coverage recorded AND CCR armed ⇒ range-restore
    // or targeted acp_retrieve would have sufficed) is the failure shape plan-
    // aware search steering exists to prevent.
    ctx.session.stats.wholeBlockRestores = (ctx.session.stats.wholeBlockRestores ?? 0) + 1;
    if (coveredRefSpan(ctx.session.state, block) !== null && ccrEnabled(ctx.session)) {
        ctx.session.stats.wholeBlockRestoresPreciseAvailable = (ctx.session.stats.wholeBlockRestoresPreciseAvailable ?? 0) + 1;
    }

    const header = `[Block ${blockId} content — ${count} item(s)${full ? ", full" : ""}]`;
    const toFileOut = toFilePointer(args, ctx, header, body);
    if (toFileOut !== null) return toFileOut;
    const spilled = autoSpillReceipt(header, body, blockId.replace(/[^a-zA-Z0-9_-]/g, "-"));
    if (spilled !== null) return spilled;
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
    if (!block.active) return toolOk(`${header}\n${body}`);
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
    return toolOk(`${header}\n${body}\n\n${refoldHint(blockId, marked.result)}`);
}

// #1995: restore the original pixels of a stripped/folded image by ref. Delivery
// is file-first — images are spilled under <stateDir>/retrieve/img/ at index time
// and their paths returned for the model to open with its read tool — uniform
// across all four wires (no per-protocol inline-image rendering). "list" enumerates
// what is currently restorable instead of writing anything.
function resolveImageRestore(args: Record<string, unknown>, ctx: ProxyToolCtx): ProxyToolResult {
    const index = ctx.session.incomingImageIndex;
    const raw = typeof args.imageRef === "string" ? args.imageRef.trim() : "";
    if (raw === "" || raw.toLowerCase() === "list") {
        if (!index || index.size === 0) {
            return toolOk("[No restorable images right now — this request carries no indexed historical images (the client must resend history bytes for them to be indexed).]");
        }
        const lines = describeRestorable(index);
        return toolOk(`[Restorable images (${lines.length}):]\n${lines.join("\n")}\nRestore one with decompress({ imageRef: "<ref>" }); it is written to a file you open with the read tool.`);
    }
    if (!index) {
        return toolFail(`[decompress FAILED: no image history is indexed for this request — cannot restore "${raw}".]`);
    }
    const imgs = index.get(raw);
    if (!imgs || imgs.length === 0) {
        return toolFail(`[decompress FAILED: no restorable image for ref "${raw}" (it carries no image, is URL-sourced with no stored bytes, or is not in this request's history). Call decompress({ imageRef: "list" }) to see what is available.]`);
    }
    // Files were spilled at index-time, so restoring is a pure lookup: return the
    // stored paths (verifying presence), never re-decoding or re-writing bytes.
    const paths: string[] = [];
    let missing = 0;
    for (const im of imgs) {
        if (existsSync(im.path)) paths.push(im.path);
        else missing++;
    }
    if (paths.length === 0) {
        return toolFail(`[decompress FAILED: the restored image(s) for "${raw}" are no longer on disk (evicted/cleaned since indexing). They will be re-spilled automatically on the next request.]`);
    }
    ctx.log(`[acp-image-restore] ${raw}: located ${paths.length} image(s) at ${paths.join(", ")}${missing ? ` (${missing} missing)` : ""}`);
    return toolOk(`[Restored ${paths.length} image(s) for ${raw}:\n${paths.map((p) => `  ${p}`).join("\n")}\nOpen them with the read tool to view the pixels.${missing ? `\n(${missing} image(s) could not be located on disk.)` : ""}]`);
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
function resolveDecompressRange(args: Record<string, unknown>, ctx: ProxyToolCtx, block: CompressionBlock): ProxyToolResult {
    const startRaw = typeof args.startId === "string" ? args.startId.trim() : "";
    const endRaw = typeof args.endId === "string" ? args.endId.trim() : "";
    if (!startRaw || !endRaw) return toolFail("[decompress FAILED: startId and endId must be given together — pass both mNNNNN refs, or omit both to restore the whole block]");
    if (!ccrEnabled(ctx.session)) {
        // Range restore needs the CCR content store; a CCR-off session has none.
        // In plugin mode the model cannot enable CCR itself (it lives in the
        // proxy's base config — plugin policy is the base block verbatim,
        // #1345), so pointing it at the setting sends it chasing a config it
        // cannot change (#1207 review F3). Give it the working call instead:
        // whole-block restore with just blockId (#1712).
        if (typeof ctx.session.metadata.pluginAgent === "string") {
            return toolFail(`[decompress FAILED: range restore (startId/endId) requires CCR, which this plugin-mode session does not have — omit startId/endId and restore the whole block: {"blockId":"${block.blockId}"}]`);
        }
        return toolFail("[decompress FAILED: range restore (startId/endId) requires CCR — enable compress.ccr.enabled]");
    }
    const sb = parseBoundary(startRaw);
    const eb = parseBoundary(endRaw);
    if (!sb || sb.kind !== "message" || !eb || eb.kind !== "message") {
        return toolFail(`[decompress FAILED: startId/endId must be mNNNNN message refs (got "${startRaw}", "${endRaw}") — block ids (bN) are not valid here]`);
    }
    if (sb.numericId > eb.numericId) return toolFail(`[decompress FAILED: startId ${startRaw} is after endId ${endRaw} — swap them]`);
    const state = ctx.session.state;
    const cov = coveredMessages(state, block);
    if (!cov) return toolFail(`[decompress FAILED: ${block.blockId} has no per-message coverage recorded (older block) — use plain decompress {blockId} for the whole block]`);
    const pickedSet = new Set(cov.raws.filter(({ num }) => num >= sb.numericId && num <= eb.numericId).map(({ raw }) => raw));
    if (pickedSet.size === 0) return toolFail(`[decompress FAILED: ${block.blockId} covers no messages in ${startRaw}–${endRaw} (its coverage is ${cov.text})]`);
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
        // #4733: a ref whose stored entry belongs to a DIFFERENT raw id is a
        // post-restamp frozen alias — serving it here would silently restore
        // another message's original under this one's citation. Treat as
        // not-found and fall through to the view text.
        if (r.ok && r.entry.rawId === raw) {
            parts.push(r.entry.toolName ? `[${r.entry.toolName} • stored]\n${r.text}` : `[${r.entry.kind} • stored]\n${r.text}`);
            restoredFromStore++;
            continue;
        }
        const m = viewById.get(raw);
        if (!m) continue;
        parts.push(m.toolName && m.contentType !== "text" ? `[${m.role} • ${m.toolName}]\n${m.text ?? ""}` : `[${m.role}]\n${m.text ?? ""}`);
    }
    if (parts.length === 0) {
        return toolFail(`[decompress FAILED: originals for ${startRaw}–${endRaw} are neither in this request's view nor in the content store (pre-CCR fold) — whole-block decompress may still work from cache]`);
    }
    const header = `[Block ${block.blockId} content — ${startRaw}–${endRaw} — ${parts.length} item(s)]`;
    let injText: string;
    const body = parts.join("\n\n");
    const toFileOut = toFilePointer(args, ctx, header, body);
    if (toFileOut !== null) {
        // #2204: a refused or unwritable export is a hard failure — return the
        // receipt directly. Nothing reached the channel, so no injection is
        // queued and no restore is counted; the block stays untouched.
        if (toFileOut.outcome === "failure") return toFileOut;
        injText = toFileOut.text;
    } else {
        // [#1207 review F4] Span stays in the file tag: two spans of one block
        // in the same millisecond must not clobber each other.
        const spilled = autoSpillReceipt(header, body, `${block.blockId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${startRaw}-${endRaw}`);
        if (spilled !== null) {
            if (spilled.outcome === "failure") return spilled;
            injText = spilled.text;
        } else {
            injText = `${header}\n${body}`;
        }
    }
    // [#1207 review F5] A client retry re-executes this path; the injection id
    // is deterministic, so dedupe on it — retries re-ack without queueing a
    // duplicate full-text message or inflating rangeRestores.
    const injId = retrievedMessageId(`range_${block.blockId}_${startRaw}-${endRaw}`);
    if (!ctx.session.pendingRetrievals.some((p) => p.ref === injId)) {
        ctx.session.pendingRetrievals.push({ ref: injId, tokens: 0, chars: body.length, queuedAt: Date.now(), ccr: false, injection: { id: injId, role: "user", contentType: "text", text: injText } });
        ctx.session.stats.rangeRestores = (ctx.session.stats.rangeRestores ?? 0) + 1;
    }
    markDirty(ctx.session);
    ctx.log(`[acp-decompress-range] ${block.blockId} ${startRaw}–${endRaw}: restored ${parts.length} item(s)${restoredFromStore ? ` (${restoredFromStore} from content store)` : ""} via ephemeral injection`);
    return toolOk(`[decompress ${block.blockId} ${startRaw}–${endRaw}: restored ${parts.length} item(s) — full content follows]`);
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

// ===================== #1336 planning-aware retrieval =====================
// Policy layer over the kernel's lexical candidate surface: when enabled, the
// full candidate pool is re-ranked against the session's current todo/task
// state (latest protectedLatestTools snapshot in context + most recent user
// turn) and a short steering section is appended. No store/fold/injection
// mechanics are touched. Absent plan state or disabled ⇒ byte-identical
// output (the stable sort degrades to the kernel's lexical order).

const EFFECTIVE_SEARCH_PLAN_KEY = "searchPlanAware";

/** Stamp the last-resolved plan-aware flag onto the session (per-request,
 *  latest wins — same pattern as storeEffectiveCcr/storeEffectiveConfig). */
export function storeEffectiveSearchPlanAware(session: Session, on: boolean): void {
    session.metadata[EFFECTIVE_SEARCH_PLAN_KEY] = on;
}

export function effectiveSearchPlanAware(session: Session | undefined): boolean {
    return session?.metadata[EFFECTIVE_SEARCH_PLAN_KEY] === true;
}

// Conservative built-ins for common agent task tools; user-configured
// protectedLatestTools patterns are added on top at search time.
const PLANNING_TOOL_PATTERNS = ["TodoWrite", "todowrite", "todo_list", "update_plan", "TaskCreate", "TaskUpdate"];
// Bounded scan window + per-snapshot char cap: stale todo state must not
// dominate ranking (risk mitigation from the issue).
const PLAN_WINDOW_MESSAGES = 40;
const PLAN_TEXT_CHAR_CAP = 4000;
// A ref retrieved this many times earns a range-restore hint in steering.
const REPEAT_RETRIEVE_HINT_THRESHOLD = 2;

const PLAN_STOPWORDS = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "has", "had",
    "was", "were", "are", "will", "would", "should", "could", "can", "may",
    "into", "onto", "over", "under", "about", "after", "before", "between",
    "each", "all", "any", "some", "not", "but", "then", "than", "when",
    "while", "where", "which", "who", "what", "how", "why", "because",
    "being", "done", "todo", "todos", "task", "tasks", "status", "pending",
    "in_progress", "completed", "cancelled", "progress", "update", "updates",
    "step", "steps", "item", "items", "list", "plan",
]);

type PlanTerms = Map<string, number>;

function planTokenize(text: string): string[] {
    const out: string[] = [];
    // Rendered ref-tag markup () is proxy metadata, not plan content.
    const clean = text.replace(/\x3cacp\b[\s\S]*?\x3c\/acp\x3e/g, " ");
    const re = /[a-z0-9]+|[\u4e00-\u9fff]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean.toLowerCase())) !== null) {
        const t = m[0];
        const cjk = /[\u4e00-\u9fff]/.test(t);
        // Latin tokens need >= 3 chars to carry signal; CJK single chars count.
        if (!cjk && t.length < 3) continue;
        if (!cjk && PLAN_STOPWORDS.has(t)) continue;
        out.push(t);
    }
    return out;
}

function resolveDerivedDecompress(
    args: Record<string, unknown>,
    ctx: ProxyToolCtx,
    blockId: string,
): ProxyToolResult {
    for (const anc of derivedAncestorSessions(ctx.session)) {
        const block = ctx.core.decompress(blockId, anc.state);
        if (!block) {
            const ancArchived = preCompactionArchiveOf(anc)[blockId];
            if (ancArchived !== undefined) {
                return toolFail(`[decompress FAILED: block ${blockId} is an archived block in derived session ${anc.id} (${ancArchived.reason}) — it was removed from live state along with its covered substrate and cannot be restored.]`);
            }
            continue;
        }
        if (preCompactionArchiveOf(anc)[blockId] !== undefined) {
            return toolFail(`[decompress FAILED: block ${blockId} is a pre-compaction archive in derived session ${anc.id} — its content was replaced by the client's compaction summary and is no longer reachable.]`);
        }
        if (hasRangeArgs(args)) {
            return toolFail(`[decompress FAILED: range restore (startId/endId) of derived-parent blocks is not supported — decompress "${blockId}" without range args (#1333)]`);
        }
        const full = args.full === true;
        const cached = anc.blockContents.get(blockId);
        const view = cached ? (full ? cached.full : (cached.one ?? cached.full)) : undefined;
        const body = view?.text || block.summary;
        const count = view?.count ?? 0;
        const header = `[Block ${blockId} content — ${count} item(s)${full ? ", full" : ""} · read-only from derived session ${anc.id} (#1333)]`;
        // #5013: mirror the gates the other restore paths carry — an explicit
        // toFile was silently ignored here, and an oversized parent block rode
        // the wire unbounded into a near-full child window.
        const toFileOut = toFilePointer(args, ctx, header, body);
        if (toFileOut !== null) return toFileOut;
        const spilled = autoSpillReceipt(header, body, `${blockId.replace(/[^a-zA-Z0-9_-]/g, "-")}-derived`);
        if (spilled !== null) return spilled;
        return toolOk(`${header}\n${body}`);
    }
    return toolFail(`[Block ${blockId} not found]`);
}

/** Extract the current plan state from the in-context message view: the LAST
 *  tool call matching each planning pattern (mirrors the kernel's
 *  collectLatestProtected latest-wins semantics — per projected path for
 *  slash patterns, so `skill/*` keeps one slot per skill, #1947) plus the
 *  most recent user turn. Returns null when nothing usable is in context. */
export function extractPlanState(messages: CoreMessage[], extraPatterns?: string[]): { terms: PlanTerms } | null {
    const patterns = [...new Set([...PLANNING_TOOL_PATTERNS, ...(extraPatterns ?? [])])];
    const start = Math.max(0, messages.length - PLAN_WINDOW_MESSAGES);
    const latestByPattern = new Map<string, CoreMessage>();
    let lastUserText: string | undefined;
    for (let i = start; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.contentType === "tool-call" && msg.toolName) {
            for (const p of patterns) {
                if (matchToolMessagePattern(msg, p)) {
                    // Slash patterns protect per projected path in the kernel;
                    // keying by pattern would collapse every skill into one
                    // global-latest slot (#1947).
                    latestByPattern.set(p.includes("/") ? toolPathOf(msg) : p, msg);
                    break;
                }
            }
        } else if (msg.role === "user" && msg.contentType === "text" && msg.text) {
            lastUserText = msg.text;
        }
    }
    const sources: Array<{ text: string; weight: number }> = [];
    for (const msg of latestByPattern.values()) if (msg.text) sources.push({ text: msg.text, weight: 2 });
    if (lastUserText) sources.push({ text: lastUserText, weight: 1 });
    if (sources.length === 0) return null;
    const terms: PlanTerms = new Map();
    for (const { text, weight } of sources) {
        const capped = text.length > PLAN_TEXT_CHAR_CAP ? text.slice(0, PLAN_TEXT_CHAR_CAP) : text;
        for (const tok of planTokenize(capped)) {
            terms.set(tok, (terms.get(tok) ?? 0) + weight);
        }
    }
    return terms.size > 0 ? { terms } : null;
}

function planBlockScore(topic: string | undefined, summary: string, terms: PlanTerms): number {
    const hay = `${topic ?? ""}\n${summary}`.toLowerCase();
    let score = 0;
    for (const [term, w] of terms) {
        if (!hay.includes(term)) continue;
        let count = 0;
        let idx = hay.indexOf(term);
        while (idx !== -1) {
            count++;
            idx = hay.indexOf(term, idx + term.length);
        }
        score += w * count;
    }
    return score;
}

function buildSteering(
    scored: Array<{ block: CompressionBlock; score: number }>,
    state: CompressionState,
    session: Session,
): string {
    const parts: string[] = [];
    const boosted = scored.filter((s) => s.score > 0).slice(0, 3);
    if (boosted.length > 0) {
        parts.push(`top fetch targets: ${boosted.map((s) => {
            const span = coveredRefSpan(state, s.block);
            return span ? `${s.block.blockId} [${span.text} · ${span.count} msgs]` : s.block.blockId;
        }).join(", ")}`);
    }
    const counts = session.retrieveCountsByRef;
    if (counts && counts.size > 0) {
        const seen = new Set<string>();
        const hints: string[] = [];
        outer: for (const s of scored.slice(0, 5)) {
            const cov = coveredMessages(state, s.block);
            if (!cov) continue;
            for (const { num } of cov.raws) {
                const ref = `m${String(num).padStart(5, "0")}`;
                const n = counts.get(ref);
                if ((n ?? 0) >= REPEAT_RETRIEVE_HINT_THRESHOLD && !seen.has(ref)) {
                    seen.add(ref);
                    hints.push(`${ref} retrieved ${n} times this session — decompress({blockId:"${s.block.blockId}",startId:"${ref}",endId:"${ref}"}) may be cheaper than repeat acp_retrieve`);
                    if (hints.length >= 2) break outer;
                }
            }
        }
        if (hints.length > 0) parts.push(hints.join("; "));
    }
    return parts.length > 0 ? `\n\n[plan-aware] ${parts.join("\n")}` : "";
}

type SearchPlanOpts = {
    messages: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
    protectedPatterns?: string[];
};

// #2751: preview windowing. The old fixed head-clamp (safePrefix 200) hid a hit
// whose only occurrence sat past char 200, and "Found N" was indistinguishable
// from "N is all that exists". Center the preview on the pool-rarest matched
// term (marking it) so unique-match evidence survives truncation; budget stays
// at the old 200-char total so output never grows unbounded.
const SNIPPET_TOTAL = 200;
const SNIPPET_AHEAD = 80;

// Code-unit-safe middle slice — never leaves a lone surrogate at an edge
// (#816/#828/#1615: hand-sliced model-visible text must reuse this discipline).
function safeMidSlice(text: string, start: number, end: number): string {
    let s = start;
    let e = end;
    if (s > 0 && s < text.length) {
        const c = text.charCodeAt(s);
        if (c >= 0xdc00 && c <= 0xdfff) s += 1;
    }
    if (e > 0 && e < text.length) {
        const c = text.charCodeAt(e - 1);
        if (c >= 0xd800 && c <= 0xdbff) e -= 1;
    }
    return text.slice(s, e);
}

function poolTermFrequency(pool: CompressionBlock[], terms: string[]): Map<string, number> {
    const freq = new Map<string, number>();
    const lower = terms.map((t) => t.toLowerCase()).filter(Boolean);
    for (const t of lower) if (!freq.has(t)) freq.set(t, 0);
    for (const b of pool) {
        const hay = `${b.topic ?? ""}\n${b.summary}`.toLowerCase();
        for (const t of lower) if (hay.includes(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    return freq;
}

// Most distinctive query term present in this block's summary = fewest
// containing blocks, tie → earliest occurrence. Null when no term is in the
// summary body (hit then lives in the topic, already shown in the header line).
function pickAnchorTerm(summary: string, terms: string[], freq: Map<string, number>): { term: string; index: number } | null {
    const lower = summary.toLowerCase();
    let best: { term: string; index: number; freq: number } | null = null;
    for (const t of terms) {
        const tl = t.toLowerCase();
        if (!tl) continue;
        const i = lower.indexOf(tl);
        if (i === -1) continue;
        const f = freq.get(tl) ?? 0;
        if (!best || f < best.freq || (f === best.freq && i < best.index)) best = { term: tl, index: i, freq: f };
    }
    return best ? { term: best.term, index: best.index } : null;
}

function markFirstMatch(text: string, needle: string): string {
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) return text;
    return text.slice(0, idx) + "\u3010" + text.slice(idx, idx + needle.length) + "\u3011" + text.slice(idx + needle.length);
}

function evidenceSnippet(summary: string, terms: string[], freq: Map<string, number>): string {
    const anchor = pickAnchorTerm(summary, terms, freq);
    if (!anchor) return summary.length > SNIPPET_TOTAL ? safePrefix(summary, SNIPPET_TOTAL) + "..." : summary;
    const start = Math.max(0, anchor.index - SNIPPET_AHEAD);
    const end = Math.min(summary.length, start + SNIPPET_TOTAL);
    const win = markFirstMatch(safeMidSlice(summary, start, end), anchor.term);
    return (start > 0 ? "... " : "") + win + (end < summary.length ? " ..." : "");
}

// #2751: for a long multi-term query, if a term is absent from every returned
// block yet present in lower-ranked candidates, steer the model to narrow to it
// rather than reading "absent from top-N" as "absent from history". At most once.
function narrowingHint(terms: string[], returned: CompressionBlock[], ranked: CompressionBlock[]): string {
    if (terms.length < 3) return "";
    const returnedSet = new Set(returned);
    const lowerCands = ranked.filter((b) => !returnedSet.has(b));
    if (lowerCands.length === 0) return "";
    const contains = (b: CompressionBlock, tl: string): boolean =>
        (b.topic ?? "").toLowerCase().includes(tl) || b.summary.toLowerCase().includes(tl);
    let best: { term: string; count: number } | null = null;
    for (const t of terms) {
        const tl = t.toLowerCase();
        if (!tl) continue;
        if (returned.some((b) => contains(b, tl))) continue;
        const count = lowerCands.filter((b) => contains(b, tl)).length;
        if (count === 0) continue;
        if (!best || count < best.count || (count === best.count && t.length > best.term.length)) best = { term: t, count };
    }
    if (!best) return "";
    return `[tip: none of the top ${returned.length} results contain "${best.term}" but ${best.count} lower-ranked candidate(s) do — try searching "${best.term}" alone to surface its block directly]`;
}

export function executeSearchContext(
    args: Record<string, unknown>,
    core: CompressionCore,
    state: CompressionState,
    foreignSessionId?: string,
    plan?: SearchPlanOpts,
): ProxyToolResult {
    const query = typeof args.query === "string" ? args.query : "";
    if (query.length === 0) return toolFail("[search_context FAILED: query is required]");
    const scope = foreignSessionId ? ` in session ${foreignSessionId}` : "";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pool = core.search(query, state);
    const freq = poolTermFrequency(pool, terms);
    let ranked = pool;
    let scored: Array<{ block: CompressionBlock; score: number }> | null = null;
    if (plan && !foreignSessionId && pool.length > limit) {
        const planState = extractPlanState(plan.messages, plan.protectedPatterns);
        if (planState) {
            const withScores = pool.map((b, i) => ({ b, i, score: planBlockScore(b.topic, b.summary, planState.terms) }));
            withScores.sort((x, y) => y.score - x.score || x.i - y.i);
            ranked = withScores.map((s) => s.b);
            scored = withScores.map((s) => ({ block: s.b, score: s.score }));
            plan.log(`[acp-search-plan] "${query}": ${withScores.filter((s) => s.score > 0).length}/${pool.length} candidates plan-relevant → ${scored.slice(0, limit).map((s) => `${s.block.blockId}:${s.score}`).join(", ")}`);
        }
    }
    const blocks = ranked.slice(0, limit);
    if (blocks.length === 0) {
        // #1875: an empty result is a valid answer to a query, not a failure.
        if (!state.blocks.some((b) => b.active)) return toolOk(`[No compressed blocks exist yet${scope} — nothing to search.]`);
        const activeCount = state.blocks.filter((b) => b.active).length;
        return toolOk(`[No blocks matched "${query}" among ${activeCount} active block(s)${scope}. Scope = active compressed topics/summaries only — NOT visible messages, inactive/distilled blocks, or other sessions; absence here ≠ never-discussed.]`);
    }
    const lines = blocks.map((b) => {
        const topic = b.topic ?? "(no topic)";
        const preview = evidenceSnippet(b.summary, terms, freq);
        // #1179 CCR v2: covered message-ref span(s) — connect block space to
        // store space so the model can target acp_retrieve / range decompress
        // at individual messages instead of whole blocks.
        const span = coveredRefSpan(state, b);
        const spanNote = span ? ` [${span.text} · ${span.count} msgs]` : "";
        return `${b.blockId} (T${b.tier}) "${topic}"${spanNote}\n  ${preview}`;
    });
    let steering = "";
    if (scored && plan && !foreignSessionId && blocks.length > 0) {
        const returned = new Set(blocks);
        steering = buildSteering(scored.filter((s) => returned.has(s.block)), state, plan.session);
    }
    const truncNote = ranked.length > blocks.length
        ? `\n\n[truncated: showing ${blocks.length} of ${ranked.length} candidates by relevance — pass limit:${ranked.length} to see the rest]`
        : "";
    const tip = narrowingHint(terms, blocks, ranked);
    const tipNote = tip ? `\n\n${tip}` : "";
    const note = foreignSessionId
        ? `\n\n[Read-only search of historical session ${foreignSessionId}. Block ids are per-session namespaces — decompress acts on the current session only. For bulk content use bili export ${foreignSessionId} [--full].]`
        : "";
    return toolOk(`Found ${blocks.length} block(s) for "${query}"${scope}:\n\n${lines.join("\n\n")}${truncNote}${steering}${tipNote}${note}`);
}

// #841: resolve a requested session id to its compression state without
// touching it — resident memory first (verbatim id or canonical alias), then
// the persisted store. Never creates, reloads or marks anything dirty.
function resolveForeignSessionState(id: string): CompressionState | null {
    const resident = peekSession(id) ?? findSessionByCanonicalId(id);
    if (resident) return resident.state;
    return getStore().loadStateForSearch(id);
}

export function executeSearchContextTarget(
    args: Record<string, unknown>,
    core: CompressionCore,
    sessionId: string,
    state: CompressionState,
    ctx?: { messages: CoreMessage[]; config: Config; session: Session; log: (msg: string) => void },
): ProxyToolResult {
    const requested = typeof args.conversation_id === "string" ? args.conversation_id.trim() : "";
    // #1336: plan-aware re-ranking applies to OWN-session searches only —
    // foreign lookups stay read-only lexical (no other session's plan state).
    const plan: SearchPlanOpts | undefined = ctx && effectiveSearchPlanAware(ctx.session)
        ? { messages: ctx.messages, session: ctx.session, log: ctx.log, protectedPatterns: ctx.config.protectedLatestTools }
        : undefined;
    // #1125: honor the param description's "Defaults to the current conversation" —
    // the literal "current" (any case) resolves to this session, not the foreign lookup.
    if (!requested || requested === sessionId || requested.toLowerCase() === "current") {
        const local = executeSearchContext(args, core, state, undefined, plan);
        // #1333: a derived session (pi RLM child) has no blocks of its own —
        // fall back to the recorded parent chain (read-only) instead of a
        // bare "nothing to search".
        if (local.text.startsWith("[No compressed blocks exist yet") || local.text.startsWith('[No blocks matched "')) {
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
    if (self?.id === sessionId) return executeSearchContext(args, core, state, undefined, plan);
    const foreign = resolveForeignSessionState(requested);
    if (!foreign) return toolFail(`[search_context FAILED: unknown session "${requested}"]`);
    return executeSearchContext(args, core, foreign, requested);
}
