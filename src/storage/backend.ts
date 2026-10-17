/**
 * Storage-backend contract (#3388 Phase A).
 *
 * The operation-level seam between the host and its persistence substrate.
 * Exactly one implementation exists today — the in-process SQLite store
 * (`UnifiedStore`, ./store.ts). Extracting this contract NOW, before any
 * networked backend lands, pins down the exact surface a backend must provide
 * and proves it green against the existing corpus, so that adding a MySQL /
 * Greenplum backend later is a small isolated diff (a new `implements
 * StorageBackend` class + factory wiring) rather than a rewrite of the
 * load-bearing store.
 *
 * Scope notes:
 *  - INSTANCE surface only. The SQLite static factory (`UnifiedStore.open`)
 *    and the engine-acquisition getters (`engine` / `engineSource`) are
 *    implementation details of the SQLite backend, not part of the generic
 *    contract — a networked backend selects its connection target through the
 *    Phase-B config knob, not a file path.
 *  - Synchronous for now, matching the current store. When the first networked
 *    backend lands (Phase C) this interface widens to async (pg/mysql2 are
 *    Promise-based) in the SAME step that adds that backend; until then only
 *    the SQLite impl exists, so evolving the signatures costs nothing here.
 */

import type {
    CcrEntryRow,
    BlockRow,
    CheckpointRow,
    IngestSessionInput,
    MessageRow,
    RefRow,
    SessionRow,
    SessionSummaryRow,
    WebSummaryRow,
} from "./store.js";
import type { MessageContentStore } from "acp-kernel";

export interface StorageBackend {
    /** Best-effort shutdown; implementations must not throw into the caller. */
    close(): void;

    /** O(1) ownership probe for the persist stale-guard (#3049). Null = no row. */
    sessionCounters(sessionId: string): { requests: number; nextBlockId: number } | null;
    /** Full or delta ingest of one session plan committed as ONE transaction. */
    ingestSession(
        input: IngestSessionInput,
        delta?: { trustedSeq: number; boundaryMsgId: string; boundaryHash: string; trustedTailSeqs: number[] },
        opts?: { completeLog?: boolean },
    ): boolean;
    ingestWatermark(sessionId: string): { seq: number; tailSeqs: number[] } | null;
    clearIngestWatermark(sessionId: string): void;
    resetAllIngestWatermarks(): void;
    probeIngestBoundary(sessionId: string, seq: number): { msgId: string; contentHash: string; maxSeq: number } | null;
    deleteSession(sessionId: string): void;

    insertCheckpoint(cp: {
        cpId: string;
        sessionId: string;
        seqAt: number;
        blockSetHash: string;
        kind: "auto" | "manual" | "replica" | "fork_base";
        label?: string | null;
        pinned: boolean;
        createdAt: number;
        stateJson: string;
    }): void;
    listCheckpoints(sessionId?: string): CheckpointRow[];
    getCheckpoint(cpId: string): CheckpointRow | undefined;
    checkpointState(cpId: string): { stateJson: string; byteLen: number };
    deleteCheckpoint(cpId: string): boolean;

    setSessionExt(sessionId: string, key: string, value: unknown): void;
    getSessionExt(sessionId: string, key: string): unknown;
    listSessionExt(sessionId: string): { key: string; value: unknown; updatedAt: number }[];
    deleteSessionExt(sessionId: string, key?: string): number;
    setKv(namespace: string, key: string, value: unknown): void;
    getKv(namespace: string, key: string): unknown;
    listKv(namespace?: string, keyPrefix?: string): { namespace: string; key: string; value: unknown; updatedAt: number }[];
    deleteKv(namespace: string, key?: string): number;

    sessionUpdatedAt(sessionId: string): number | null;
    listSessionIds(): string[];
    lookupConversation(namespace: string, conversationId: string): string | null;
    listConversationBindings(namespace?: string): { namespace: string; conversationId: string; sessionId: string; claimedAt: number }[];

    sessionSummaries(): SessionSummaryRow[];
    webSummaryRows(): WebSummaryRow[];

    getSessionRow(sessionId: string): SessionRow | null;
    getMessages(sessionId: string): (MessageRow & { contentHash: string })[];
    getBlocks(sessionId: string): (BlockRow & { summaryHash: string; oneHash: string | null })[];
    getDeadRefs(sessionId: string): { ord: number; ref: string; refNum: number; recordedAt: number }[];
    getRefs(sessionId: string): RefRow[];
    getCcr(sessionId: string): MessageContentStore | null;
    getCcrEntries(sessionId: string): CcrEntryRow[];

    verifyProjections(sessionId: string): { ok: true; checks: number } | { ok: false; error: string };
    counts(): Record<string, number>;
    contentDedupReport(): { rows: number; bytesTotal: number; refcounted: number };
}
