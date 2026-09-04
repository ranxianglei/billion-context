import {
    collectBlockContent,
    type CompressionCore,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { preCompactionArchiveOf, type Session } from "./session.js";

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
 *  STATELESS RETRIEVAL: decompress is copy-paste — it changes no state. The
 *  block stays active, the forwarded view keeps folding, the cache is kept
 *  (repeat decompresses are free), and there is no expand/re-fold cycle.
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
    if (!block) return `[Block ${blockId} not found]`;
    const archived = preCompactionArchiveOf(ctx.session);
    if (archived[blockId] !== undefined) {
        return `[decompress FAILED: block ${blockId} is a pre-compaction archive — its content was in the history BEFORE the client's native compaction and is no longer reachable (replaced by the client's compaction summary). decompress is unavailable for archived blocks.]`;
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
            writeFileSync(outPath, body, "utf8");
            trackedTempFiles.push({ path: outPath, mtimeMs: Date.now() });
            reapTempFiles();
            return `${header}\nContent (${body.length} chars) written to: ${outPath}\nUse the read tool to access it.`;
        } catch (e) {
            return `${header}\n[Failed to write to ${outPath}: ${String(e)}]\n${body.slice(0, 4000)}...`;
        }
    }
    return `${header}\n${body}`;
}
