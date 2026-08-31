import {
    collectBlockContent,
    deactivateBlock,
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
    session: Session;
    log: (msg: string) => void;
};

/** Resolve a decompress request to a result string, honoring the `full` flag
 *  and the cross-round original-content cache on the session.
 *
 *  - If the block has cached originals (captured at compress time), use the
 *    cached `one` or `full` view per the flag. This is the cross-round-safe
 *    path: ctx.messages only holds the folded view by the time decompress runs.
 *  - Otherwise fall back to collectBlockContent against ctx.messages; if that
 *    yields nothing (originals already folded out), return the block summary.
 *  - deactivateBlock + delete the cache ONLY when content was actually
 *    recovered. A 0-count, no-cache result leaves the block active for retries. */
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
        const view = full ? cached.full : cached.one;
        body = view.text;
        count = view.count;
    } else {
        const collected = collectBlockContent(ctx.session.state, block, ctx.messages, { full });
        body = collected.text || block.summary;
        count = collected.count;
    }

    if (count > 0 || cached) {
        ctx.session.state = deactivateBlock(ctx.session.state, [blockId]);
        // Drop the cached originals now that the block is deactivated — it
        // cannot be decompressed again, and keeping large original messages
        // around grows memory unbounded over a long session.
        ctx.session.blockContents.delete(blockId);
    }

    const header = `[Restored block ${blockId} — ${count} item(s)${full ? ", full" : ""}]`;
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
