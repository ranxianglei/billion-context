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
 * #5519 fork exception to "accumulate from zero": a session that just
 * adopted its parent's compression state (applyForkAdoption arms
 * metadata.cacheMarkLadderInitPending) has NO mark history of its own, but
 * its stable region already runs hundreds of messages long — the plain
 * single-tail push would leave its first turns one anchor deep while most of
 * the shared prefix sits behind no cached segment at all. The child has sent
 * nothing under its own identity yet, so its INITIAL layout owes no
 * byte-stability debt: the first mark pass seeds the full ladder across the
 * stable region (tail + half + quarter) instead of the single tail, then
 * hands back to the sticky cumulative dynamics above unchanged (from turn 2
 * on, marks are frozen at the cap exactly like any other session).
 *
 * Client-managed caching wins: any pre-existing cache_control (harvested
 * from the client's messages, present on system blocks, or on tools entries —
 * the 4-breakpoint budget counts all three) suppresses our stamps entirely
 * (pass no marks / return the system unchanged).
 * BILI_NO_CACHE_CONTROL / compat.noCacheControl disables everything.
 */

const MESSAGE_MARK_CAP = 3;

type AnthropicCacheMarks = Map<string, { type: "ephemeral" }>;

export function computeAnthropicMessageMarks(
    processed: { id?: string }[],
    ephemeralTailCount: number,
    session: { metadata: Record<string, unknown> },
): AnthropicCacheMarks {
    const marks = new Map<string, { type: "ephemeral" }>();
    if (knobNoCacheControl()) {
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
    // #5519: one-shot ladder seed for a freshly adopted fork/resume. The flag
    // is consumed by every pass that reaches this point (seeded or not), so
    // no later turn re-lays-out mid-history. A client-managed or too-short
    // FIRST turn never reaches this point and leaves the flag pending — safe:
    // the seed is a first-appearance layout, not a rewrite of stamped bytes.
    const ladderInitPending = session.metadata["cacheMarkLadderInitPending"] === true;
    delete session.metadata["cacheMarkLadderInitPending"];
    if (ladderInitPending && kept.length === 0 && lastIndex >= 3) {
        // Tail + half + quarter of the stable region: three anchors spanning
        // what is already cached-worthy, deepest last so the list stays in
        // positional order like the steady-state accumulator produces.
        for (const frac of [0.25, 0.5, 1]) {
            const at = Math.floor(lastIndex * frac);
            const id = processed[at]?.id;
            if (typeof id === "string" && id.length > 0 && !kept.includes(id)) kept.push(id);
        }
    } else {
        const currentId = processed[lastIndex]?.id;
        if (typeof currentId === "string" && currentId.length > 0 && !kept.includes(currentId) && kept.length < MESSAGE_MARK_CAP) {
            kept.push(currentId);
        }
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

/** Count the cache_control breakpoints on a tools array (WC-010's combined
 *  budget counts every one, not just whether any exist). */
export function countAnthropicToolsCacheControls(tools: unknown): number {
    if (!Array.isArray(tools)) return 0;
    let n = 0;
    for (const t of tools) {
        if (typeof t === "object" && t !== null && (t as { cache_control?: unknown }).cache_control !== undefined) n++;
    }
    return n;
}

/** Count the cache_control breakpoints on a top-level system field. */
export function countAnthropicSystemCacheControls(system: unknown): number {
    if (!Array.isArray(system)) return 0;
    let n = 0;
    for (const b of system) {
        if (typeof b === "object" && b !== null && (b as { cache_control?: unknown }).cache_control !== undefined) n++;
    }
    return n;
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

export function stampAnthropicSystemCacheControl(systemOut: AnthropicRequestBody["system"], ours = true): AnthropicRequestBody["system"] {
    if (knobNoCacheControl()) return systemOut;
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
    // Stamp by replacement, never in place: the array may share block
    // references with the frozen client head (parsed.system), which must stay
    // unmarked (#1085).
    const last = systemOut.length - 1;
    systemOut[last] = { ...systemOut[last], cache_control: { type: "ephemeral" } };
    return systemOut;
}
