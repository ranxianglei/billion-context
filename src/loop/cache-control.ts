import type { AnthropicRequestBody } from "acp-kernel/wire";

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
 * BILI_NO_CACHE_CONTROL=1 disables everything.
 */

const MESSAGE_MARK_CAP = 3;

export type AnthropicCacheMarks = Map<string, { type: "ephemeral" }>;

export function computeAnthropicMessageMarks(
    processed: { id?: string }[],
    ephemeralTailCount: number,
    session: { metadata: Record<string, unknown> },
): AnthropicCacheMarks {
    const marks = new Map<string, { type: "ephemeral" }>();
    if (process.env.BILI_NO_CACHE_CONTROL) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return marks;
    }
    if (processed.length === 0 || processed.length <= ephemeralTailCount) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return marks;
    }
    const liveIds = new Set(processed.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0));
    // Retire marks whose messages folded away; keep the survivors' order.
    const kept = ((session.metadata["anthropicCacheMarkIds"] as string[] | undefined) ?? []).filter((id) => liveIds.has(id));
    const lastIndex = processed.length - 1 - ephemeralTailCount;
    const currentId = processed[lastIndex]?.id;
    if (typeof currentId === "string" && currentId.length > 0 && !kept.includes(currentId) && kept.length < MESSAGE_MARK_CAP) {
        kept.push(currentId);
    }
    session.metadata["anthropicCacheMarkIds"] = kept;
    for (const id of kept) marks.set(id, { type: "ephemeral" });
    return marks;
}

/** WC-010: Anthropic's 4-breakpoint budget spans system blocks + tools entries
 *  + message blocks COMBINED; anthropicToCore only harvests messages, so a
 *  tools-only client mark must suppress ours too or the 5th breakpoint 400s. */
export function anthropicToolsCarryCacheControl(tools: unknown): boolean {
    if (!Array.isArray(tools)) return false;
    return tools.some((t) => typeof t === "object" && t !== null && (t as { cache_control?: unknown }).cache_control !== undefined);
}

export function stampAnthropicSystemCacheControl(systemOut: AnthropicRequestBody["system"], ours = true): AnthropicRequestBody["system"] {
    if (process.env.BILI_NO_CACHE_CONTROL) return systemOut;
    if (!ours) return systemOut;
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
    (systemOut[systemOut.length - 1] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
    return systemOut;
}
