import type { AnthropicRequestBody } from "acp-kernel/wire";
import { noCacheControl as knobNoCacheControl } from "../knobs.js";

/**
 * #1637: Anthropic prompt caching is EXPLICIT — content blocks must carry
 * `cache_control` breakpoints or nothing upstream caches. bili used to emit
 * none, so Anthropic-style upstreams never cached anything bili sent, and
 * relays that breakpoint only the system block left the ENTIRE history
 * re-billing at full price on every request (#1631: cached pinned at the
 * system head, 9–13%, for 40+ requests straight).
 *
 * Both the steady request path (prepareAnthropic) and the compress-loop
 * round-2 rebuild (adapter-anthropic) apply THE SAME marks through the
 * kernel's own `coreToAnthropic(messages, cacheControls)` machinery — one
 * applier, identical bytes on both paths (the dual-builder divergence class
 * the cache matrix pins; see #1554).
 *
 * Cadence: CUMULATIVE incremental breakpoints (Anthropic-recommended). A
 * marked message STAYS marked — removing a mid-history marker mutates that
 * element's bytes on the next request and breaks the byte prefix exactly
 * there. Marks die only by folding (covered messages vanish from the view).
 * Once the cap is reached no NEW marks are added until a fold retires
 * covered ones: a rolling drop would mutate an early element and collapse
 * the LCP. Cap = 3 message marks + 1 system breakpoint = Anthropic's 4-block
 * limit.
 *
 * Client-managed caching wins: any pre-existing cache_control (harvested
 * from the client's messages, present on system blocks, or on tools entries —
 * the 4-breakpoint budget counts all three) suppresses our stamps entirely
 * (pass no marks / return the system unchanged).
 * BILI_NO_CACHE_CONTROL / compat.noCacheControl disables everything.
 */

const ANTHROPIC_BREAKPOINT_BUDGET = 4;
const MESSAGE_MARK_CAP = 3;

type AnthropicCacheMarks = Map<string, unknown>;

export function anthropicSystemCacheControlCount(system: unknown): number {
    if (!Array.isArray(system)) return 0;
    let count = 0;
    for (const block of system) {
        if (typeof block === "object" && block !== null && (block as { cache_control?: unknown }).cache_control !== undefined) {
            count++;
        }
    }
    return count;
}

export function anthropicToolsCacheControlCount(tools: unknown): number {
    if (!Array.isArray(tools)) return 0;
    let count = 0;
    for (const t of tools) {
        if (typeof t === "object" && t !== null && (t as { cache_control?: unknown }).cache_control !== undefined) {
            count++;
        }
    }
    return count;
}

/** WC-010: Anthropic's 4-breakpoint budget spans system blocks + tools entries
 *  + message blocks COMBINED. */
export function anthropicToolsCarryCacheControl(tools: unknown): boolean {
    return anthropicToolsCacheControlCount(tools) > 0;
}

function isGlobalScopeControl(cc: unknown): boolean {
    return typeof cc === "object" && cc !== null && (cc as { scope?: unknown }).scope === "global";
}

/** WC-016: Anthropic rejects any `cache_control` with `scope: "global"` after a
 *  narrower breakpoint in request order (`tools` -> `system` -> `messages`). */
export function clientCarriesGlobalCacheScope(
    tools: unknown,
    system: unknown,
    clientCacheControls?: Map<string, unknown>,
): boolean {
    if (Array.isArray(tools)) {
        for (const t of tools) {
            if (typeof t === "object" && t !== null && isGlobalScopeControl((t as { cache_control?: unknown }).cache_control)) {
                return true;
            }
        }
    }
    if (Array.isArray(system)) {
        for (const block of system) {
            if (typeof block === "object" && block !== null && isGlobalScopeControl((block as { cache_control?: unknown }).cache_control)) {
                return true;
            }
        }
    }
    if (clientCacheControls) {
        for (const ctrl of clientCacheControls.values()) {
            if (isGlobalScopeControl(ctrl)) return true;
        }
    }
    return false;
}

export function computeAnthropicMessageMarks(
    processed: { id?: string; contentType?: string }[],
    ephemeralTailCount: number,
    session: { metadata: Record<string, unknown> },
    clientCacheControls?: Map<string, unknown>,
    reservedNonMessageBreakpoints = 0,
    globalScopePresent = false,
    allowSupplementalClientAnchor = true,
): AnthropicCacheMarks | undefined {
    const hasClientMsgMarks = (clientCacheControls?.size ?? 0) > 0;
    if (knobNoCacheControl() || globalScopePresent) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return hasClientMsgMarks ? new Map(clientCacheControls) : (globalScopePresent ? undefined : new Map());
    }
    if (processed.length === 0 || processed.length <= ephemeralTailCount) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return hasClientMsgMarks ? new Map(clientCacheControls) : new Map();
    }

    if (hasClientMsgMarks && !allowSupplementalClientAnchor) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return new Map(clientCacheControls);
    }

    const clientMsgCount = clientCacheControls?.size ?? 0;
    const availableForBiliMessages = hasClientMsgMarks
        ? Math.max(0, ANTHROPIC_BREAKPOINT_BUDGET - reservedNonMessageBreakpoints - clientMsgCount)
        : Math.min(MESSAGE_MARK_CAP, Math.max(0, ANTHROPIC_BREAKPOINT_BUDGET - Math.max(1, reservedNonMessageBreakpoints)));

    const markableIds = new Set(
        processed
            .filter((m) => m.contentType !== "reasoning")
            .map((m) => m.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0 && !clientCacheControls?.has(id)),
    );
    const kept = ((session.metadata["anthropicCacheMarkIds"] as string[] | undefined) ?? [])
        .filter((id) => markableIds.has(id))
        .slice(0, availableForBiliMessages);

    if (kept.length < availableForBiliMessages) {
        let searchStart = processed.length - 1 - ephemeralTailCount;
        if (hasClientMsgMarks) {
            let earliestClientIdx = -1;
            for (let i = 0; i < processed.length; i++) {
                const id = processed[i]?.id;
                if (typeof id === "string" && clientCacheControls!.has(id)) {
                    earliestClientIdx = i;
                    break;
                }
            }
            if (earliestClientIdx > 0) {
                searchStart = Math.min(searchStart, earliestClientIdx - 1);
            }
        }
        let currentId: string | undefined;
        for (let i = searchStart; i >= 0; i--) {
            const m = processed[i];
            if (
                m &&
                m.contentType !== "reasoning" &&
                typeof m.id === "string" &&
                m.id.length > 0 &&
                !clientCacheControls?.has(m.id)
            ) {
                currentId = m.id;
                break;
            }
        }
        if (currentId !== undefined && !kept.includes(currentId)) {
            kept.push(currentId);
        }
    }
    session.metadata["anthropicCacheMarkIds"] = kept;
    const marks: AnthropicCacheMarks = new Map();
    if (clientCacheControls) {
        for (const [id, ctrl] of clientCacheControls) marks.set(id, ctrl);
    }
    for (const id of kept) marks.set(id, { type: "ephemeral" });
    return marks;
}

const CLIENT_MARK_IDS_KEY = "anthropicClientCacheMarks";

/** #6861: pin CLIENT-managed message breakpoints cumulatively — the same
 *  discipline as computeAnthropicMessageMarks, applied to the client's own
 *  marks. Claude Code stamps a cache_control breakpoint on its last message
 *  (+ last assistant message) and MOVES it as the conversation grows (#2188),
 *  and anthropicToCore harvests those controls into a per-request map that
 *  coreToAnthropic re-emits verbatim. Re-emitting only the current request's
 *  marks rewrites the old message's bytes on the next request (its breakpoint
 *  is gone) — a mid-history rewrite on EVERY request that breaks the byte
 *  prefix exactly there and collapses the cache to the system-only checkpoint
 *  (one #6861 request hit 8.7%). A marked message STAYS marked: once a client
 *  breakpoint is seen on a message, keep re-emitting it there in later
 *  requests, so the outbound history stays append-stable and the checkpoint
 *  at that position keeps matching. Pinned marks die only by folding (their
 *  message leaves the live view). The client's current marks are always emitted
 *  (they are the client's caching intent); pinning only adds the historical
 *  ones back, within Anthropic's 4-breakpoint budget (system + tools + message
 *  marks combined, WC-010). If the merged set would exceed the budget, the
 *  NEWEST pinned-only marks are evicted until it fits, so any seam lands next
 *  to the tail, never on an early element. Returns the merged map for
 *  coreToAnthropic (and for the round-2 adapter via anthropicClientCacheControls,
 *  #2499). */
export function pinClientMessageMarks(
    clientControls: Map<string, unknown>,
    liveIds: Set<string>,
    session: { metadata: Record<string, unknown> },
    messageCap: number,
): Map<string, unknown> {
    const merged = new Map<string, unknown>(clientControls);
    if (knobNoCacheControl()) {
        delete session.metadata[CLIENT_MARK_IDS_KEY];
        return merged;
    }
    const raw = session.metadata[CLIENT_MARK_IDS_KEY];
    const pinned: { id: string; control: unknown }[] = [];
    if (Array.isArray(raw)) {
        for (const entry of raw) {
            if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" && (entry as { id: string }).id.length > 0) {
                pinned.push({ id: (entry as { id: string }).id, control: (entry as { control?: unknown }).control });
            }
        }
    }
    // Retire marks whose messages folded away; keep the survivors' order.
    let kept = pinned.filter((p) => liveIds.has(p.id));
    // Pin the client's current marks (first-marked order) for later requests.
    for (const [id, control] of clientControls) {
        if (!liveIds.has(id)) continue;
        if (kept.some((p) => p.id === id)) continue;
        kept.push({ id, control });
    }
    for (const p of kept) {
        if (!merged.has(p.id)) merged.set(p.id, p.control);
    }
    // WC-010 safety valve: the emitted set (pinned + current) must fit
    // Anthropic's 4-breakpoint budget. The client's current marks are never
    // dropped; evict the NEWEST pinned-only marks until it fits, so any
    // seam lands next to the tail, never on an early element.
    while (merged.size > messageCap) {
        let evicted = false;
        for (let i = kept.length - 1; i >= 0; i--) {
            if (!clientControls.has(kept[i]!.id)) {
                merged.delete(kept[i]!.id);
                kept.splice(i, 1);
                evicted = true;
                break;
            }
        }
        if (!evicted) break;
    }
    session.metadata[CLIENT_MARK_IDS_KEY] = kept;
    return merged;
}

export function stampAnthropicSystemCacheControl(
    systemOut: AnthropicRequestBody["system"],
    ours = true,
    remainingBudget = 1,
): AnthropicRequestBody["system"] {
    if (knobNoCacheControl()) return systemOut;
    if (!ours || remainingBudget <= 0) return systemOut;
    if (typeof systemOut === "string" && systemOut.length > 0) {
        // Deterministic string→block conversion (semantically identical for
        // Anthropic; stable across turns). A string system can carry no
        // client cache_control, so conversion never discards one.
        return [{ type: "text", text: systemOut, cache_control: { type: "ephemeral" } }];
    }
    if (!Array.isArray(systemOut) || systemOut.length === 0) return systemOut;
    for (const block of systemOut) {
        if ((block as { cache_control?: unknown }).cache_control) return systemOut;
    }
    // Stamp by replacement, never in place: the array may share block
    // references with the frozen client head (parsed.system), which must stay
    // unmarked (#1085).
    const last = systemOut.length - 1;
    systemOut[last] = { ...systemOut[last], cache_control: { type: "ephemeral" } };
    return systemOut;
}

/** Stamp bili's system breakpoint only while the shared 4-breakpoint budget
 *  (tools + system + messages) has room and no client global-scope control
 *  precedes it. Single source of truth for steady egress and round-2 rebuilds. */
export function stampSystemWithinAnthropicBudget(
    systemOut: AnthropicRequestBody["system"],
    tools: unknown,
    originalSystem: unknown,
    effectiveMarks: Map<string, unknown> | undefined,
    enableBiliSystemStamp: boolean,
): AnthropicRequestBody["system"] {
    if (!enableBiliSystemStamp) return systemOut;
    if (clientCarriesGlobalCacheScope(tools, originalSystem, effectiveMarks)) return systemOut;
    const reservedNonMsg = anthropicSystemCacheControlCount(originalSystem) + anthropicToolsCacheControlCount(tools);
    const remainingBudget = Math.max(0, ANTHROPIC_BREAKPOINT_BUDGET - reservedNonMsg - (effectiveMarks?.size ?? 0));
    return stampAnthropicSystemCacheControl(systemOut, true, remainingBudget);
}
