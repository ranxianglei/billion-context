/** Marker contract for blocks whose summaries were written by the configured
 *  external summary chain (#1018 area) instead of the model itself.
 *
 *  Kept in a leaf module with zero imports so display surfaces (panel status,
 *  web session details, acp_status spans) can consume it without pulling the
 *  compression pipeline (and its cycles) into their import graph. The kernel
 *  never parses compressCallId — this prefix is display-only metadata. */
import { randomUUID } from "node:crypto";

export const EXTERNAL_SUMMARY_CALL_ID_PREFIX = "external-summary-";

/** Mint a fresh marker compressCallId for a block folded by the external
 *  summary chain (model-tool path and preflight auto-fold path alike). */
export const newExternalCallId = (): string => `${EXTERNAL_SUMMARY_CALL_ID_PREFIX}${randomUUID()}`;

/** True when a compression block's summary was written by the external
 *  summary chain. Display-only. */
export function isExternalSummaryBlock(block: { compressCallId?: string }): boolean {
    return typeof block.compressCallId === "string" && block.compressCallId.startsWith(EXTERNAL_SUMMARY_CALL_ID_PREFIX);
}
