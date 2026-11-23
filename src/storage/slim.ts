import { sha256Hex } from "./store.js";
import type { MessageContentStore, StoredEntry } from "acp-kernel";

/**
 * #6785 step 6 — the slim ccr envelope.
 *
 * The sessions.ccr_json column used to carry the FULL content store
 * (byHash: hash → original text, byRef: ref → entry), so every
 * steady-state flush re-wrote the whole CCR body through the sessions
 * row even when nothing changed. The content now lives in the
 * content-addressed store behind ccr_entries — one row per entry with
 * BOTH halves: the entry metadata (content_hash) and the original text
 * it points at (orig_hash, #6785 step 6). The column therefore only
 * needs the ENVELOPE: which refs exist and which content-hash backs
 * each entry. Bytes come back through the CAS on read.
 *
 * Kernel invariant this leans on (content-store.ts storeOriginal):
 * byHash[entry.hash] === original text, entry.hash = hashContent(text).
 */
interface SlimCcrEnvelope {
    version: 1;
    ccrSlim: 1;
    byRef: Record<string, { hash: string }>;
    /** byHash entries no byRef entry points at (host-pruned refs — the
     *  "retained CCR" case). Rare and small; they ride the envelope so the
     *  slim round-trip stays lossless in both halves. */
    orphanByHash?: Record<string, string>;
}

export function slimCcrEnvelope(contentStore: { byRef: Record<string, unknown>; byHash?: Record<string, string> }): SlimCcrEnvelope {
    const byRef: Record<string, { hash: string }> = {};
    for (const [key, value] of Object.entries(contentStore.byRef)) {
        byRef[key] = { hash: sha256Hex(JSON.stringify(value)) };
    }
    // "referenced" = the original hashes some entry points at (entry.hash,
    //    kernel invariant) — NOT the envelope's content-hash values.
    const referenced = new Set(
        Object.values(contentStore.byRef)
            .map((v) => (v !== null && typeof v === "object" && typeof (v as { hash?: unknown }).hash === "string" ? (v as { hash: string }).hash : null)),
    );
    const orphanByHash: Record<string, string> = {};
    for (const [hash, text] of Object.entries(contentStore.byHash ?? {})) {
        if (!referenced.has(hash)) orphanByHash[hash] = text;
    }
    return Object.keys(orphanByHash).length > 0
        ? { version: 1, ccrSlim: 1, byRef, orphanByHash }
        : { version: 1, ccrSlim: 1, byRef };
}

export interface CcrLedgerRow {
    key: string;
    /** JSON.stringify(byRef[key]) as planIngest wrote it. */
    content: string;
    /** The original text behind entry.hash (CAS-served); null when the
     *  row predates the orig_hash column (legacy rows — the full column
     *  envelope still carries those stores). */
    origContent: string | null;
}

/**
 * Rebuilds the content store from ccr_entries rows (CAS-served content) in
 * ledger order. byRef[key] is the parsed entry — the row content IS
 * JSON.stringify(value) as planIngest wrote it, so the round-trip is exact.
 * byHash is rebuilt from the SAME rows through each entry's own hash key,
 * matching the live store's canonical form (the kernel invariant above).
 * A legacy row (origContent null) contributes its byRef entry only — the
 * full column envelope remains the authority for pre-step-6 stores, so no
 * partial byHash is ever mixed with a slim one. Returns null when there
 * are no rows at all — callers degrade to the file lane, never a partial
 * store.
 */
function hydrateCcrContentStore(
    rows: readonly CcrLedgerRow[],
): MessageContentStore | null {
    if (rows.length === 0) return null;
    const byHash: Record<string, string> = {};
    const byRef: Record<string, StoredEntry> = {};
    for (const r of rows) {
        let entry: unknown;
        try {
            entry = JSON.parse(r.content);
        } catch {
            continue;
        }
        byRef[r.key] = entry as StoredEntry;
        if (
            r.origContent !== null
            && entry !== null
            && typeof entry === "object"
            && typeof (entry as { hash?: unknown }).hash === "string"
        ) {
            byHash[(entry as { hash: string }).hash] = r.origContent;
        }
    }
    return { version: 1, byHash, byRef };
}

/**
 * The ONE definition of "rebuild a slim column's store" — used by BOTH the
 * view leg (resolveCcrContentStore) and the direct getCcr path. Legacy
 * NULL-orig rows, an EMPTY ledger (unless the orphans half alone forms a
 * real store), a MISSING content body, or an envelope/ledger KEY-SET MISMATCH
 * ⇒ null (the file lane stays authority; never a partial store). Orphan
 * byHash entries ride the envelope and are merged over the ledger's byHash.
 */
export function hydrateSlimCcrStore(
    parsed: { ccrSlim?: number; orphanByHash?: unknown; byRef?: Record<string, unknown> },
    rows: readonly CcrLedgerRow[],
): MessageContentStore | null {
    if (parsed.ccrSlim !== 1) return null;
    const orphans: Record<string, string> =
        parsed.orphanByHash !== undefined && parsed.orphanByHash !== null && typeof parsed.orphanByHash === "object"
            ? (parsed.orphanByHash as Record<string, string>)
            : {};
    // A ledger row whose CAS body was lost (getCcrEntries maps a missing
    // body to "") would otherwise be silently DROPPED by the JSON.parse
    // catch below — serving a partial store. Degrade instead.
    if (rows.some((r) => r.content === "")) return null;
    // Envelope/ledger key-set coverage: every byRef key the column
    // declares must have a ledger row, or the hydrated byRef is a strict
    // subset of the column's — a partial store the file lane would serve
    // whole. (Column and ledger are written in one tx; this is the
    // read-side safety net for the invariant, not a fast path.)
    if (parsed.byRef !== undefined && parsed.byRef !== null) {
        const rowKeys = new Set(rows.map((r) => r.key));
        for (const key of Object.keys(parsed.byRef)) {
            if (!rowKeys.has(key)) return null;
        }
    }
    if (rows.length === 0) {
        // Empty envelope + empty ledger is the ALWAYS-empty store: server.ts
        // materializes createContentStore() ({byHash:{},byRef:{}}) for every
        // session (contentStoreOf ?? fallback), so the column carries a slim
        // envelope with zero refs for every plain session. The envelope's own
        // key-set coverage check above already proved nothing is declared,
        // so this is a COMPLETE empty store, not a partial one.
        return { version: 1, byHash: orphans, byRef: {} };
    }
    if (!rows.every((r) => r.origContent !== null)) return null;
    const store = hydrateCcrContentStore(rows);
    if (!store) return null;
    store.byHash = { ...store.byHash, ...orphans };
    return store;
}

/**
 * #6785 step 8: the kstate slim split. The sessions.kstate_json column keeps
 * only the BOUNDED fields (nudge, stats, latches, counters, digests); the
 * UNBOUNDED record/array fields (each can grow to MB across a long session)
 * ride one row each in state_fields. The set is frozen: adding a field here
 * is a read-path decision (the builder must know it is row-backed), so it is
 * pinned by tests/issue5874-state-fields.test.ts and reviewed with the
 * kernel-type pin (kernel/src/types.ts field shapes).
 */
export const ROW_BACKED_KSTATE_FIELDS: readonly string[] = Object.freeze([
    "tokenSnapshot",
    "tsStamps",
    "lastPassIds",
    "hiddenOrphanRefs",
    "sweptOrphanCallIds",
    "renderDeferredRefs",
    "viewLatches",
    "absorbed",
    "rules",
]);

const ROW_BACKED_SET = new Set(ROW_BACKED_KSTATE_FIELDS);

/** Split an ordered kstate object (MERGE_STATE_FIELDS order) into the
 *  column part (order-preserving, row-backed fields removed) and the row
 *  part (field → serialized value, only for DEFINED row-backed fields). */
export function splitKstate(
    fields: readonly string[],
    state: Record<string, unknown>,
): { column: Record<string, unknown>; rows: Record<string, string> } {
    const column: Record<string, unknown> = {};
    const rows: Record<string, string> = {};
    for (const field of fields) {
        const v = state[field];
        if (v === undefined) continue;
        if (ROW_BACKED_SET.has(field)) rows[field] = JSON.stringify(v);
        else column[field] = v;
    }
    return { column, rows };
}

/**
 * #7574 (review of #6785) — "is this value the older build's default?".
 * A build that predates the state_fields rows loads a session WITHOUT the
 * nine row-backed fields and writes the column back with whatever its own
 * code put there — nothing, or an empty container. Used by the view
 * builder to tell "the older build had nothing" (empty) from "something
 * was added while the older build ran" (non-empty = newer than the row).
 */
export function isEmptyStateValue(v: unknown): boolean {
    if (v === null || v === undefined || v === "" || v === 0 || v === false) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v as object).length === 0;
    return false;
}

/**
 * #7574 (review of #6785) — rollback self-heal of the content store.
 *
 * The slim column is written by this build only. When an OLDER build
 * (pre-#6785) opens the library it parses that column as if it were the
 * old full envelope: every byRef entry shrinks to its `{ hash }` stub and
 * byHash is gone, and its next save writes exactly that back — so after
 * re-upgrading, tool outputs and file reads showed as `{ hash }` with no
 * text although the text was still in the ledger (ccr_entries: the older
 * build does not know that table and leaves it alone).
 *
 * A full column together with ledger rows only arises that way (this build
 * writes the slim column and the rows in the same transaction). So the
 * ledger is used to fill what the column lost — nothing else is touched:
 *   - an entry whose original text is missing in the column gets it from
 *     the ledger row with the same key, when that row's entry carries the
 *     same content hash;
 *   - when the column's entry is a pure projection of the ledger's (the
 *     `{ hash }` stub), the ledger's full entry replaces it; an entry the
 *     older build changed in any other way is kept as written;
 *   - entries the ledger has no text for are counted (`stillMissing`).
 * Returns null when there was nothing to fill.
 */
export function refillFullEnvelope(
    parsed: { byRef?: unknown; byHash?: unknown },
    rows: readonly CcrLedgerRow[],
): { store: MessageContentStore | null; refilled: number; stillMissing: number } {
    const none = { store: null, refilled: 0, stillMissing: 0 } as const;
    if (rows.length === 0) return none;
    if (parsed.byRef === null || parsed.byRef === undefined || typeof parsed.byRef !== "object" || Array.isArray(parsed.byRef)) return none;
    const byRef = { ...(parsed.byRef as Record<string, unknown>) };
    const byHash: Record<string, unknown> = parsed.byHash !== null && parsed.byRef !== undefined && typeof parsed.byHash === "object" && !Array.isArray(parsed.byHash)
        ? { ...(parsed.byHash as Record<string, unknown>) }
        : {};
    const rowByKey = new Map<string, CcrLedgerRow>();
    for (const r of rows) if (!rowByKey.has(r.key)) rowByKey.set(r.key, r);
    let refilled = 0;
    let stillMissing = 0;
    for (const key of Object.keys(byRef)) {
        const raw = byRef[key];
        if (raw === null || raw === undefined || typeof raw !== "object") continue;
        const hash = (raw as { hash?: unknown }).hash;
        if (typeof hash !== "string") continue;
        if (typeof byHash[hash] === "string") continue; // the text is there
        const row = rowByKey.get(key);
        let rowEntry: Record<string, unknown> | null = null;
        if (row !== undefined && row.origContent !== null) {
            try {
                const parsedRow = JSON.parse(row.content) as unknown;
                if (parsedRow !== null && typeof parsedRow === "object" && !Array.isArray(parsedRow)) rowEntry = parsedRow as Record<string, unknown>;
            } catch { /* not an entry — counted as missing below */ }
        }
        if (row === undefined || row.origContent === null || rowEntry === null || rowEntry.hash !== hash) {
            stillMissing++;
            continue;
        }
        const columnEntry = raw as Record<string, unknown>;
        const isProjection = Object.keys(columnEntry).every((k) => JSON.stringify(columnEntry[k]) === JSON.stringify(rowEntry![k]));
        if (isProjection) byRef[key] = rowEntry;
        byHash[hash] = row.origContent;
        refilled++;
    }
    if (refilled === 0) return { store: null, refilled: 0, stillMissing };
    return {
        store: { version: 1, byHash: byHash as Record<string, string>, byRef: byRef as Record<string, StoredEntry> },
        refilled,
        stillMissing,
    };
}
