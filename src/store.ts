import {
    applyRetrieve,
    buildStoredPlaceholder,
    contentStoreStats,
    createContentStore,
    DEFAULT_CCR_CONFIG,
    noteRetrieval,
    RETRIEVE_TOOL_NAME,
    type Config as KernelConfig,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { getStore } from "./persist.js";
import type { CompressSettings } from "./config.js";
import type { PendingRetrieval, Session } from "./session.js";

export type CcrSettings = NonNullable<CompressSettings["ccr"]>;

const EFFECTIVE_CCR_KEY = "effectiveCcr";

/** Stamp the last-resolved CCR policy onto the session (per-request; the
 *  processTurn loop config must match or be stripped, mirroring absorb). */
export function storeEffectiveCcr(session: Session, ccr: CcrSettings | undefined): void {
    session.metadata[EFFECTIVE_CCR_KEY] = ccr ?? null;
    // [review #1273] Disarming must also drop any queued full-text injection:
    // a retrieve issued on a lane that later switches to a non-CCR wire
    // (responses/google, or the plugin base-config gate above) would otherwise
    // flush as a stale trailing full-text message whenever the lane re-arms at
    // an unrelated conversation point. [#1343] The drop is now OBSERVABLE —
    // every acked-but-undelivered ref is logged with its reason and a
    // corrective note is queued, instead of a silent truncate.
    if (!ccr) {
        const carrierRefs = carrierOf(session).map((p) => p.ref);
        const ledgerRefs = readLedger(session).map((e) => e.ref);
        const allRefs = [...new Set([...carrierRefs, ...ledgerRefs])];
        if (allRefs.length > 0) dropRetrievals(session, allRefs, "CCR disarmed before delivery");
    }
}

/** Read back the CCR policy stamped by {@link storeEffectiveCcr}. */
export function effectiveCcr(session: Session | undefined): CcrSettings | undefined {
    const meta = session?.metadata[EFFECTIVE_CCR_KEY];
    if (meta && typeof meta === "object" && typeof (meta as CcrSettings).enabled === "boolean") {
        return meta as CcrSettings;
    }
    return undefined;
}

export function ccrEnabled(session: Session | undefined): boolean {
    return effectiveCcr(session)?.enabled === true;
}

/** Model-facing retrieve tool name for this session: the config `ccr.toolName`
 *  override when set, else the kernel default. */
export function retrieveToolName(session: Session | undefined): string {
    return effectiveCcr(session)?.toolName ?? RETRIEVE_TOOL_NAME;
}

/** [#1345] The loop config's ccr block must be exactly what the session stamp
 *  says — the stamp is the single CCR policy source for the whole pipeline:
 *  disarmed → stripped; armed → resolved (defaults filled) from the stamped
 *  block, NOT from the request-resolved config. In plugin mode the two can
 *  differ by design: the static manifest governs, so the entire plugin-mode
 *  ccr block follows the base config (see the stamp site in server.ts). */
export function ccrLoopConfig(session: Session | undefined, config: KernelConfig): KernelConfig {
    if (!ccrEnabled(session)) return { ...config, ccr: undefined };
    const eff = effectiveCcr(session);
    if (!eff) return config;
    return { ...config, ccr: { ...DEFAULT_CCR_CONFIG, ...eff } };
}

// [#1271] Wire protocols that support plugin-mode CCR. The agent advertises
// acp_retrieve from the manifest and rides the full original back via the
// request-only injection in prepare* — which exists only for these two wires.
// google (strict role-alternation) and responses (fragile developer-message
// mechanics, no real plugin lane) are excluded so a placeholder is never emitted
// on a wire that cannot round-trip it (silent loss, #1097). The arming gate and
// the drain sites must stay in lockstep with this set.
export const PLUGIN_CCR_WIRES: ReadonlySet<string> = new Set(["anthropic", "openai"]);

export function ccrPluginWireOk(protocol: string): boolean {
    return PLUGIN_CCR_WIRES.has(protocol);
}

/** Lazily materialize the session's kernel content-store envelope: loaded
 *  from the session's content-store.json on first touch, fresh when the file
 *  is absent (or corrupt — degraded to retrieve misses, never a crash). */
export function contentStoreOf(session: Session): MessageContentStore {
    if (!session.contentStore) {
        session.contentStore = getStore().loadContentStore(session) ?? createContentStore();
    }
    return session.contentStore;
}

/** Adopt the store returned by kernel processTurn (append-only, first write
 *  wins — refs are never rewritten). Stats and the persist dirty flag move
 *  only when new entries appeared, so a no-growth turn costs nothing. */
export function adoptContentStore(session: Session, store: MessageContentStore): void {
    const prev = session.contentStore;
    const added = prev
        ? Object.entries(store.byRef).filter(([ref]) => !(ref in prev.byRef))
        : Object.entries(store.byRef);
    session.contentStore = store;
    if (added.length === 0) return;
    let saved = 0;
    for (const [ref, entry] of added) {
        const placeholder = buildStoredPlaceholder({
            ref,
            kind: entry.kind,
            tokens: entry.tokens,
            head: entry.head,
            retrieveToolName: retrieveToolName(session),
        });
        saved += Math.max(0, entry.chars - Buffer.byteLength(placeholder, "utf8"));
    }
    session.stats.storedBytes = contentStoreStats(store).totalChars;
    session.stats.storeBytesSaved = (session.stats.storeBytesSaved ?? 0) + saved;
    session.contentStoreDirty = true;
}

/** Ref-filtered independent clone of a content store (#1341): copies exactly
 *  the byRef entries named in `refs` plus their byHash payloads (content-
 *  addressed, so two refs sharing a hash copy one payload). Entry objects are
 *  shallow-copied — the result shares no mutable state with the source.
 *  Returns null when nothing matches: callers must not seed an empty store
 *  (no artifact, no dirty flag). */
export function cloneStoreForRefs(store: MessageContentStore, refs: Iterable<string>): MessageContentStore | null {
    const wanted = new Set(refs);
    const byRef: MessageContentStore["byRef"] = {};
    const byHash: MessageContentStore["byHash"] = {};
    for (const [ref, entry] of Object.entries(store.byRef)) {
        if (!wanted.has(ref)) continue;
        byRef[ref] = { ...entry };
        const text = store.byHash[entry.hash];
        if (text !== undefined && !(entry.hash in byHash)) byHash[entry.hash] = text;
    }
    return Object.keys(byRef).length > 0 ? { version: 1, byHash, byRef } : null;
}

/** Execute a retrieve-tool call against the kernel store: resolve the ref,
 *  count hit/miss, and queue the full-text injection for the re-request path
 *  (request-only, same channel as nudges — never persisted, structurally
 *  excluded from refs). Returns the deterministic ack that rides as the tool
 *  result on every wire. A hallucinated ref costs one tool call by design. */
export function executeRetrieve(args: Record<string, unknown>, session: Session): string {
    session.stats.retrieveCalls = (session.stats.retrieveCalls ?? 0) + 1;
    const rawRef = args.ref;
    const ref = typeof rawRef === "string" ? rawRef.trim() : "";
    if (!ref) {
        session.stats.retrieveMisses = (session.stats.retrieveMisses ?? 0) + 1;
        return `[${retrieveToolName(session)} FAILED: ref (an mNNNNN id) is required]`;
    }
    const result = applyRetrieve({ store: contentStoreOf(session), ref });
    if (!result.ok) {
        session.stats.retrieveMisses = (session.stats.retrieveMisses ?? 0) + 1;
        loggerLog("info", `[ccr] retrieve ${ref}: miss (${result.reason})`);
        return result.ackText;
    }
    session.stats.retrieveHits = (session.stats.retrieveHits ?? 0) + 1;
    session.state = noteRetrieval(session.state);
    // [#1343] Queue with durable bookkeeping: the ack above is committed NOW,
    // but the full text only reaches the model on a later upstream request.
    // The ledger tracks it until delivered or dropped (never silently lost).
    queueRetrieval(session, { ref, tokens: result.entry.tokens, chars: result.entry.chars, injection: result.injection });
    loggerLog("info", `[ccr] retrieve ${ref} (${result.entry.tokens} tok, ${result.entry.chars} chars)`);
    return result.ackText;
}

// [#1343] Delivery lifecycle for queued retrievals. The ack is committed the
// moment executeRetrieve returns, but the full text only reaches the model on a
// LATER upstream request — so every item is tracked through
//   queued → attached (snapshot onto a Prepared) → delivered | dropped
// and NO loss may be silent: each drop logs refs+count+reason and queues a
// corrective note. Durable bookkeeping lives in session.metadata (round-trips
// to disk unchanged); the injection payloads stay in-memory only.

type UndeliveredEntry = { ref: string; tokens: number; chars: number };
type DropNote = { refs: string[]; reason: string };
const DEFAULT_RETRIEVAL_TTL_MS = 10 * 60 * 1000;

function readLedger(session: Session): UndeliveredEntry[] {
    const v = session.metadata.ccrUndelivered;
    return Array.isArray(v) ? (v as UndeliveredEntry[]) : [];
}

// Some session paths (and test harnesses) leave the in-memory carrier unset;
// treat an absent carrier as empty rather than crash (preserves the pre-#1343
// `pendingRetrievals?.length` tolerance). Writers assign a defined array.
function carrierOf(session: Session): PendingRetrieval[] {
    return session.pendingRetrievals ?? [];
}

function retrievalTtlMs(): number {
    const raw = process.env.BILI_CCR_RETRIEVAL_TTL_MS;
    if (raw === undefined || raw === "") return DEFAULT_RETRIEVAL_TTL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETRIEVAL_TTL_MS;
}

function bufferDropNote(session: Session, refs: string[], reason: string): void {
    const existing = session.metadata.ccrDropNotes;
    const arr = Array.isArray(existing) ? (existing as DropNote[]) : [];
    arr.push({ refs, reason });
    session.metadata.ccrDropNotes = arr;
}

/** Queue a hit for later delivery: add the ephemeral injection carrier plus a
 *  durable ledger entry (deduped by ref — a ref is never reused, kernel
 *  contract). Returns nothing; the ack is produced by executeRetrieve. */
export function queueRetrieval(session: Session, r: Omit<PendingRetrieval, "queuedAt">): void {
    const carrier = session.pendingRetrievals ?? (session.pendingRetrievals = []);
    if (carrier.some((p) => p.ref === r.ref)) return;
    carrier.push({ ...r, queuedAt: Date.now(), ccr: true });
    let ledger = readLedger(session);
    if (!ledger.some((e) => e.ref === r.ref)) {
        session.metadata.ccrUndelivered = [...ledger, { ref: r.ref, tokens: r.tokens, chars: r.chars }];
    }
}

/** Snapshot the currently-queued items WITHOUT removing them. Plugin-lane
 *  prepares attach these to the outgoing request; the items stay in the queue
 *  until commit/drop, so an overflow-refold re-prepare re-sends them and a
 *  concurrent same-session request is resolved by ref-set filtering. */
export function snapshotPendingRetrievals(session: Session): PendingRetrieval[] {
    return carrierOf(session).slice();
}

/** Confirmed upstream success: remove the delivered refs from carrier + ledger
 *  and count them. Idempotent (a concurrent prior removal is a no-op). */
export function commitRetrievals(session: Session, refs: Iterable<string>): void {
    const requested = [...new Set(refs)];
    if (requested.length === 0) return;
    const reqSet = new Set(requested);
    const carrier = carrierOf(session);
    const ledger = readLedger(session);
    const inCarrier = carrier.filter((p) => reqSet.has(p.ref));
    const inLedger = ledger.filter((e) => reqSet.has(e.ref));
    if (inCarrier.length === 0 && inLedger.length === 0) return;
    session.pendingRetrievals = carrier.filter((p) => !reqSet.has(p.ref));
    session.metadata.ccrUndelivered = ledger.filter((e) => !reqSet.has(e.ref));
    // Only CCR retrieves count as delivered; plain carriers (#1207 range restore) are removed without touching the metric.
    const ccr = new Set<string>([...inCarrier.filter((p) => p.ccr).map((p) => p.ref), ...inLedger.map((e) => e.ref)]);
    if (ccr.size > 0) session.stats.retrieveDelivered = (session.stats.retrieveDelivered ?? 0) + ccr.size;
}

/** Undelivered loss: remove the refs from carrier + ledger, log refs+count+
 *  reason at warn, bump the failure counter, and queue a corrective note for
 *  the next round. Idempotent. */
export function dropRetrievals(session: Session, refs: Iterable<string>, reason: string): void {
    const requested = [...new Set(refs)];
    if (requested.length === 0) return;
    const reqSet = new Set(requested);
    const carrier = carrierOf(session);
    const ledger = readLedger(session);
    const inCarrier = carrier.filter((p) => reqSet.has(p.ref));
    const inLedger = ledger.filter((e) => reqSet.has(e.ref));
    if (inCarrier.length === 0 && inLedger.length === 0) return;
    session.pendingRetrievals = carrier.filter((p) => !reqSet.has(p.ref));
    session.metadata.ccrUndelivered = ledger.filter((e) => !reqSet.has(e.ref));
    // Plain carriers (#1207 range restore) lose on failure exactly as before — silently removed.
    // Only CCR acks get the observable loss (log + counter + corrective note).
    const ccrRefs = [...new Set([...inCarrier.filter((p) => p.ccr).map((p) => p.ref), ...inLedger.map((e) => e.ref)])];
    if (ccrRefs.length === 0) return;
    const tok = inCarrier.filter((p) => p.ccr).reduce((s, p) => s + p.tokens, 0);
    session.stats.retrieveDropped = (session.stats.retrieveDropped ?? 0) + ccrRefs.length;
    loggerLog("warn", `[ccr] ${ccrRefs.length} retrieval(s) not delivered (${reason}): ${ccrRefs.join(", ")}${tok ? ` (${tok} tok)` : ""}`);
    bufferDropNote(session, ccrRefs, reason);
}

/** Loud TTL expiry: drop items still waiting for a qualifying request past the
 *  window (window 4 — no silent multi-turn leakage). */
export function pruneExpiredRetrievals(session: Session, now = Date.now()): void {
    const ttl = retrievalTtlMs();
    if (ttl <= 0) return;
    const expired = carrierOf(session).filter((p) => p.ccr && now - p.queuedAt > ttl).map((p) => p.ref);
    if (expired.length > 0) dropRetrievals(session, expired, `still queued after ${ttl}ms without a delivery request`);
}

/** Restart detection: after a reload the in-memory carrier is empty but the
 *  durable ledger may still hold acked-but-never-delivered refs. Any such ref
 *  with NO live carrier was lost across the restart — report it. Refs that DO
 *  have a live carrier (re-retrieved post-load) are left alone for normal
 *  delivery. Keyed off ccrReconcilePending (set at load), NOT `restored`:
 *  getSession() clears the latter on the first request — the very request
 *  this reconcile must run in (#1343 review). */
export function reconcileReloadedRetrievals(session: Session): void {
    if (!session.ccrReconcilePending) return;
    session.ccrReconcilePending = false;
    const carried = new Set(carrierOf(session).map((p) => p.ref));
    const lost = readLedger(session).filter((e) => !carried.has(e.ref)).map((e) => e.ref);
    if (lost.length > 0) dropRetrievals(session, lost, "proxy restarted before delivery");
}

/** Consolidate buffered drop notes into ONE model-facing correction and clear
 *  them. Returns null when nothing is pending. Rides as an ephemeral trailing
 *  user message (same channel as nudges). */
export function flushRetrievalNotes(session: Session): string | null {
    const v = session.metadata.ccrDropNotes;
    if (!Array.isArray(v) || v.length === 0) return null;
    const notes = v as DropNote[];
    delete session.metadata.ccrDropNotes;
    const lines = notes.map((n) => `${n.refs.join(", ")}: ${n.reason}`).join("; ");
    return `[billion-context] Earlier acp_retrieve result(s) were NOT delivered, so their acks are stale and you do NOT have that content: ${lines}. Re-issue acp_retrieve for any ref above to fetch it.`;
}

/** Proxy-mode drain: ack + injection are composed within ONE response flow (no
 *  cross-request window), so draining commits delivery immediately. Preserves
 *  the four-wire proxy happy path and ack/injection pairing. */
export function drainPendingRetrievals(session: Session): CoreMessage[] {
    pruneExpiredRetrievals(session);
    const items = carrierOf(session).slice();
    if (items.length === 0) return [];
    session.pendingRetrievals = [];
    commitRetrievals(session, items.map((i) => i.ref));
    return items.map((i) => i.injection);
}
