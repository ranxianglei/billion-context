import {
    applyRetrieve,
    buildStoredPlaceholder,
    contentStoreStats,
    createContentStore,
    noteRetrieval,
    RETRIEVE_TOOL_NAME,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { getStore } from "./persist.js";
import { markDirty } from "./session.js";
import type { CompressSettings } from "./config.js";
import type { Session } from "./session.js";

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
    // an unrelated conversation point. Not persisted either way (#persist resets
    // on load) — this only tightens the in-memory window.
    if (!ccr) {
        // [#1343] A disarmed lane cannot deliver queued full-text injections:
        // the retrieve ack already promised the text, so log the loss loudly
        // instead of clearing silently.
        if (session.pendingRetrievals.length > 0) {
            loggerLog("warn", `[ccr] lane disarmed with ${session.pendingRetrievals.length} undelivered retrieval injection(s) (ack'd, never delivered) — dropping queue (#1343)`);
            session.pendingRetrievals.length = 0;
        }
        // Invariant: a delivered batch must never be resurrected by an
        // unrelated later forward failure once the lane re-arms (#1343).
        session.lastRetrievalDrain = undefined;
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

const RETRIEVAL_QUEUE_MAX = 4;

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
    // [#1343] Bound the queue: a lane that never drains (non-CCR wire after a
    // mode switch, or a client that stops re-requesting) must not accumulate
    // full-text injections indefinitely. Oldest is dropped with a log line —
    // same honest-loss shape as the disarm clear above.
    if (session.pendingRetrievals.length >= RETRIEVAL_QUEUE_MAX) {
        const dropped = session.pendingRetrievals.shift();
        loggerLog("warn", `[ccr] retrieval queue full (max ${RETRIEVAL_QUEUE_MAX}); dropping oldest undelivered injection ${dropped?.id ?? ""} (#1343)`);
    }
    session.pendingRetrievals.push(result.injection);
    markDirty(session);
    loggerLog("info", `[ccr] retrieve ${ref} (${result.entry.tokens} tok, ${result.entry.chars} chars)`);
    return result.ackText;
}

/** Drain queued retrieval injections: callers append them to the re-request
 *  message list AFTER the tool-result pair (ack first, full text second).
 *  [#1343] A fresh drain invalidates the previous drain's requeue ticket:
 *  only the most recent in-flight batch may be restored on forward failure —
 *  a delivered batch must never be resurrected by a later request's error. */
export function drainPendingRetrievals(session: Session): CoreMessage[] {
    session.lastRetrievalDrain = undefined;
    if (!session.pendingRetrievals?.length) return [];
    const drained = session.pendingRetrievals.splice(0);
    markDirty(session);
    return drained;
}

/** Record a drained batch as in-flight so a failed forward can requeue it
 *  (#1343, window 2: post-drain, pre-success). Call after appending the
 *  drained messages to the outgoing list. */
export function trackRetrievalDrain(session: Session, drained: CoreMessage[]): void {
    if (drained.length > 0) session.lastRetrievalDrain = drained;
}

/** [#1343] A forward that failed before upstream accepted the request
 *  requeues the tracked batch: the retrieve ack already told the model the
 *  full text follows, so silent loss would strand the delivery contract.
 *  The requeued injections ride the next successful forward. */
export function requeueRetrievalsOnFailure(session: Session | undefined, reason: string): void {
    const drained = session?.lastRetrievalDrain;
    if (!drained || drained.length === 0) return;
    session.pendingRetrievals.unshift(...drained);
    session.lastRetrievalDrain = undefined;
    markDirty(session);
    loggerLog("warn", `[ccr] ${reason}: requeued ${drained.length} undelivered retrieval injection(s) — they ride the next successful forward (#1343)`);
}
