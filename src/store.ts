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
    if (!ccr) session.pendingRetrievals.length = 0;
}

/** Read back the CCR policy stamped by {@link storeEffectiveCcr}. */
export function effectiveCcr(session: Session | undefined): CcrSettings | undefined {
    const meta = session?.metadata[EFFECTIVE_CCR_KEY];
    if (meta && typeof meta === "object" && typeof (meta as CcrSettings).enabled === "boolean") {
        return meta as CcrSettings;
    }
    return undefined;
}

/** [#1345] The name the plugin manifest advertises: the BASE-config
 *  ccr.toolName — handlePluginManifest reads only the global compress block,
 *  route/model merges never reach it. */
export function advertisedRetrieveToolName(ccr: CcrSettings | undefined): string {
    return ccr?.toolName ?? RETRIEVE_TOOL_NAME;
}

/** [#1345] Plugin mode stamps the session under the ADVERTISED name: a
 *  provider/model toolName override would otherwise dispatch under a name
 *  the host never registered — the model's calls rejected as unknown tools
 *  while CCR reports enabled. Proxy mode injects the tool per request under
 *  the session name, so per-route renaming keeps working there. Warns once
 *  per session. */
export function normalizePluginCcrName(
    stamped: CcrSettings,
    optsCcr: CcrSettings | undefined,
    session: Session,
    log: (level: string, msg: string) => void,
): CcrSettings {
    const advertised = advertisedRetrieveToolName(optsCcr);
    if ((stamped.toolName ?? RETRIEVE_TOOL_NAME) === advertised) return stamped;
    if (session.metadata.ccrNameOverrideWarned !== true) {
        log(
            "warn",
            `[ccr] plugin mode: ignoring provider/model ccr.toolName "${stamped.toolName ?? RETRIEVE_TOOL_NAME}" — the manifest advertises "${advertised}" (base config); per-route renaming stays a proxy-mode feature (#1345)`,
        );
        session.metadata.ccrNameOverrideWarned = true;
    }
    return { ...stamped, toolName: advertised };
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
    session.pendingRetrievals.push(result.injection);
    loggerLog("info", `[ccr] retrieve ${ref} (${result.entry.tokens} tok, ${result.entry.chars} chars)`);
    return result.ackText;
}

/** Drain queued retrieval injections: callers append them to the re-request
 *  message list AFTER the tool-result pair (ack first, full text second). */
export function drainPendingRetrievals(session: Session): CoreMessage[] {
    return session.pendingRetrievals?.length ? session.pendingRetrievals.splice(0) : [];
}
