// #5765: host executors for block retirement (acp_retire / acp_restore) and
// external summary rewrite (acp_rewrite). The kernel owns the state mutation
// (kernel/src/block-ops.ts); this module parses tool args, formats receipts,
// and marks the session dirty so the change persists.
import { retireBlocks, restoreBlocks, rewriteBlockSummary, type Config } from "acp-kernel";
import { markDirty, type Session } from "./session.js";
import { toolFail, toolOk, type ProxyToolResult } from "./proxy-tool-result.js";

// The kernel's ACP_TOOL_NAMES deliberately excludes the block ops (they are
// opt-in, config.blockOps.enabled — same pattern as absorb), so surface and
// dispatch adjudication must check the resolved config alongside the static
// set. Two config sources exist: wire paths carry the per-request resolved
// Config, while the plugin tool API resolves sessions without a request
// context and falls back to the base kernel Config — prepare* therefore
// stores the last resolved blockOps block per session for that path to read.
const EFFECTIVE_BLOCK_OPS_KEY = "effectiveBlockOps";

export function blockOpsEnabled(config: Config): boolean {
    return config.blockOps?.enabled === true;
}

export function effectiveBlockOpsConfig(session: Session | undefined, fallback: Config): { enabled: boolean } | undefined {
    const meta = session?.metadata[EFFECTIVE_BLOCK_OPS_KEY];
    if (meta && typeof meta === "object" && typeof (meta as { enabled: boolean }).enabled === "boolean") {
        return meta as { enabled: boolean };
    }
    return fallback.blockOps;
}

export function storeEffectiveBlockOps(session: Session, config: Config): void {
    const value = config.blockOps ?? null;
    // Default-off footprint stays zero: with no blockOps block configured and
    // nothing stored yet, write nothing — the persisted session state (and its
    // storage-render golden digest) is byte-identical to a pre-#5765 proxy.
    if (value !== null || EFFECTIVE_BLOCK_OPS_KEY in session.metadata) {
        session.metadata[EFFECTIVE_BLOCK_OPS_KEY] = value;
    }
}

function collectBlockIds(args: Record<string, unknown>): string[] {
    const ids: string[] = [];
    const push = (v: unknown): void => {
        if (typeof v === "string" && v.trim().length > 0) ids.push(v.trim());
        else if (typeof v === "number" && Number.isInteger(v) && v >= 0) ids.push(String(v));
    };
    if (args.blockId !== undefined) push(args.blockId);
    if (Array.isArray(args.ids)) for (const item of args.ids) push(item);
    return [...new Set(ids)];
}

function opReceipt(toolName: string, outcome: ReturnType<typeof retireBlocks>, verb: string, extra?: string): ProxyToolResult {
    const parts: string[] = [];
    if (outcome.applied.length > 0) parts.push(`${outcome.applied.join(", ")} ${verb}`);
    if (outcome.noop.length > 0) parts.push(`${outcome.noop.join(", ")} already ${verb === "retired" ? "retired" : "active"}`);
    const failed = outcome.failed.map((f) => `${f.id}: ${f.reason}`).join("; ");
    if (failed.length > 0) parts.push(`failed — ${failed}`);
    const text = `[${toolName}: ${parts.join("; ")}${extra ? `; ${extra}` : ""}]`;
    return outcome.applied.length > 0 || outcome.noop.length > 0 ? toolOk(text) : toolFail(`[${toolName} FAILED: ${parts.join("; ")}]`);
}

export function executeAcpRetire(args: Record<string, unknown>, session: Session): ProxyToolResult {
    const ids = collectBlockIds(args);
    if (ids.length === 0) return toolFail("[acp_retire FAILED: blockId or ids is required]");
    const outcome = retireBlocks(session.state, ids);
    // Applied ids only, measured after the flip: the summary text survives the
    // flag change, and counting the raw input list would inflate the receipt
    // with noop/failed ids.
    const freedChars = outcome.applied.reduce(
        (sum, id) => sum + (session.state.blocks.find((b) => b.blockId === id)?.summary.length ?? 0),
        0,
    );
    if (outcome.applied.length > 0) markDirty(session);
    return opReceipt("acp_retire", outcome, "retired", `~${freedChars} summary chars leave the resident view; acp_restore({ blockId }) puts one back and decompress/search_context still work on retired blocks`);
}

export function executeAcpRestore(args: Record<string, unknown>, session: Session): ProxyToolResult {
    const ids = collectBlockIds(args);
    if (ids.length === 0) return toolFail("[acp_restore FAILED: blockId or ids is required]");
    const outcome = restoreBlocks(session.state, ids);
    if (outcome.applied.length > 0) markDirty(session);
    return opReceipt("acp_restore", outcome, "restored");
}

export function executeAcpRewrite(args: Record<string, unknown>, session: Session): ProxyToolResult {
    type Item = { blockId: string; summary: string };
    const items: Item[] = [];
    if (typeof args.blockId === "string" && typeof args.summary === "string") {
        items.push({ blockId: args.blockId.trim(), summary: args.summary });
    }
    let skippedItems = 0;
    if (Array.isArray(args.items)) {
        for (const raw of args.items) {
            if (raw && typeof raw === "object" && typeof (raw as Item).blockId === "string" && typeof (raw as Item).summary === "string") {
                items.push({ blockId: (raw as Item).blockId.trim(), summary: (raw as Item).summary });
            } else {
                skippedItems += 1;
            }
        }
    }
    if (items.length === 0) return toolFail('[acp_rewrite FAILED: provide { blockId, summary } or items: [{ blockId, summary }] (batch)]');
    const lines: string[] = [];
    let appliedCount = 0;
    for (const item of items) {
        const res = rewriteBlockSummary(session.state, item.blockId, item.summary);
        if (res.ok) {
            appliedCount += 1;
            lines.push(`${res.blockId} summary replaced (${res.prevChars} → ${res.newChars} chars)`);
        } else {
            lines.push(`${res.id}: ${res.reason}`);
        }
    }
    if (skippedItems > 0) lines.push(`${skippedItems} item(s) skipped — each entry needs string blockId and summary`);
    if (appliedCount > 0) markDirty(session);
    const note = "previous summary kept for rollback; decompress originals are unchanged";
    const text = `[acp_rewrite: ${lines.join("; ")}; ${note}]`;
    return appliedCount > 0 ? toolOk(text) : toolFail(`[acp_rewrite FAILED: ${lines.join("; ")}]`);
}
