import { createHash } from "node:crypto";

/**
 * Anonymous prefix-affinity session resolution (#309, replaces the #286
 * content-fingerprint 400 for clients that cannot send any identity).
 *
 * Stateless clients (dsh web, third-party harnesses) replay their FULL
 * conversation history on every request. That replay itself is a stable
 * identity signal: hash the message list into an append-only chain
 * (h_i = sha256(h_{i-1} || msg_i)) and resolve the request to the session
 * whose stored chain is the LONGEST strict prefix of the incoming chain.
 *
 * This mirrors vLLM/SGLang radix prefix caching, lifted from KV-block reuse
 * to the identity layer. The crucial difference from the removed
 * content-fingerprint (#286 hashed the FIRST user message — a permanent
 * collision anchor): a prefix match degrades gracefully — two conversations
 * sharing an opening only share a session until they diverge, then the
 * divergent request no longer matches the stored chain and forks into its
 * own session (self-healing, at most one transient merged turn).
 *
 * Semantics that cannot be avoided without client ids: a fork (edited or
 * diverged history sharing a prefix) rejoins the session of the branch that
 * most recently extended it. Two truly distinct conversations merge only
 * while byte-identical.
 *
 * Partitioning — deliberately absent (#286 lesson): protocol, upstream
 * origin and credentials are all MUTABLE MID-CONVERSATION (bearer rotation,
 * relay switching, protocol-translating relays). Partitioning by them orphans
 * state exactly when the user keeps talking. The content chain is the only
 * immutable anchor: the same person switching keys or relays mid-conversation
 * keeps the session, which is the correct semantics. Safety: matching a stored
 * chain requires possessing a byte-identical history, so the folded state
 * reveals nothing the requester does not already hold.
 */

/** Creation/match floor on the canonical size of the hashed messages.
 *  Excludes degenerate probes (empty / system-only requests) that carry no
 *  usable conversation signal. Below it the request keeps the #286 400. */
const MIN_CANONICAL_BYTES = 24;

/** Upper bound on tracked chains (LRU-evicted, global — content is the
 *  only key, so there are no per-credential buckets). */
const MAX_TRACKED_SESSIONS = 256;

/** Chains unused for this long stop matching (sessions may outlive tracking). */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tail-window reattach window (#316 / PR-B): the incoming's LEADING items
 *  are searched for as a contiguous run at ANY offset inside each stored
 *  chain's per-item hashes (the incoming head is the retained suffix of the
 *  stored history, but a rolling-window client may retain any number of
 *  items, so the match offset must be free — not pinned to the stored tail). */
const TAIL_WINDOW = 8;

/** Minimum window size (items) for a tail-window reattach to be trusted. A
 *  1-2 item window is too weak a signal (a single shared message is common);
 *  below this the request falls through to a new session as before. */
const MIN_TAIL_MATCH = 3;

/** Per tracked chain, store at most this many per-item hashes (the trailing
 *  ones). Bounds memory (256 chains × 128 × 64B ≈ 2MB) and keeps the tail
 *  window (8) comfortably available. Chains deeper than this lose their head,
 *  so fork-lineage prefix detection is best-effort for very long chains. */
const MAX_STORED_ITEMS = 128;

/** Minimum shared prefix (items) to record a "forked" lineage on a new
 *  session. UI/debug only — never used for matching. */
const MIN_FORK_PREFIX = 3;

export interface AnonymousAffinity {
    /** Stable session id: "pfa-" + short hash of (tail, depth). */
    sessionId: string;
    /** Depth of the matched stored chain; 0 when this request creates the session. */
    matchedDepth: number;
    /** Depth of the stored chain that was matched (== matchedDepth when hit). */
    storedDepth: number;
    /** Incoming message count. */
    incomingDepth: number;
    /** Chain hash of the incoming tail (log correlation). */
    tailHash: string;
    /** How the session was resolved: a full-prefix match, a tail-window
     *  reattach (truncated replay), or a brand-new session. */
    via: "prefix" | "tail-window" | "new";
    /** Per-item hashes of the incoming (trailing, capped at MAX_STORED_ITEMS) —
     *  passed to note() so the tracked chain can serve future tail-window
     *  reattach + fork-lineage lookups. */
    itemHashes: string[];
    /** Lineage for a NEW session: the discarded match candidates and why they
     *  were abandoned. Recorded for UI/debug only — NEVER used for matching. */
    lineage?: { parents: string[]; reason: "truncated" | "forked"; sharedPrefix?: number };
}

interface ChainEntry {
    sessionId: string;
    depth: number;
    tailHash: string;
    lastSeen: number;
    /** Per-item hashes (position-independent sha256 of each canonical
     *  message), trailing, capped at MAX_STORED_ITEMS. */
    itemHashes: string[];
}

/** On-disk snapshot entry (#499 P1a): the tracked chains persisted across
 *  restarts so an anonymous replay reattaches its session instead of
 *  forking a fresh one with zero compression state (the #351 failure mode:
 *  a 458K-token history resent raw because the affinity was in-memory). */
export interface AffinitySnapshotEntry {
    sessionId: string;
    depth: number;
    tailHash: string;
    itemHashes: string[];
    lastSeen: number;
}

/** Deterministic JSON with recursively sorted object keys, so two replays
 *  of the same logical message hash identically regardless of key order. */
export function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
        return out;
    }
    return value;
}

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function hasUserMessage(messages: unknown[]): boolean {
    return messages.some((m) => !!m && typeof m === "object" && (m as { role?: unknown }).role === "user");
}

/** Progressive chain hashes: hashes[i] covers messages[0..i]. */
function chainHashes(messages: unknown[]): string[] {
    const hashes: string[] = [];
    let prev = "";
    let bytes = 0;
    for (const message of messages) {
        const canonical = stableStringify(message);
        bytes += canonical.length;
        prev = sha256(`${prev}\u0000${canonical}`);
        hashes.push(prev);
    }
    return bytes >= MIN_CANONICAL_BYTES ? hashes : [];
}

/** Position-INDEPENDENT per-item hashes: itemHashes[i] = sha256(canonical(msg_i)).
 *  Unlike the progressive chainHashes (which depend on the full prefix and so
 *  cannot match across a truncation), these let a window of the incoming head
 *  be compared against a window of a stored tail item-for-item. */
function perItemHashes(messages: unknown[]): string[] {
    return messages.map((m) => sha256(stableStringify(m)));
}

/** Length of the longest common prefix of two per-item hash arrays. */
function lcpLength(a: string[], b: string[]): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
}

export class PrefixAffinityResolver {
    private trackedChains = new Map<string, ChainEntry>();

    /**
     * Resolve an anonymous request to a session id.
     * Returns null when the request carries no usable conversation signal
     * (caller keeps the #286 explicit 400).
     */
    resolve(messages: unknown[]): AnonymousAffinity | null {
        const hashes = chainHashes(messages);
        if (hashes.length === 0 || !hasUserMessage(messages)) return null;
        const incomingDepth = hashes.length;
        const tailHash = hashes[incomingDepth - 1]!;
        const incItemHashes = perItemHashes(messages);
        const storedItemHashes = incItemHashes.slice(-MAX_STORED_ITEMS);
        const tracked = this.trackedChains;
        this.expire(tracked);

        // 1. Full-depth prefix match (the original radix-style resolution).
        let best: ChainEntry | undefined;
        for (const entry of tracked.values()) {
            if (entry.depth > incomingDepth) continue;
            if (hashes[entry.depth - 1] !== entry.tailHash) continue;
            if (!best || entry.depth > best.depth || (entry.depth === best.depth && entry.lastSeen > best.lastSeen)) best = entry;
        }
        if (best) {
            return {
                sessionId: best.sessionId,
                matchedDepth: best.depth,
                storedDepth: best.depth,
                incomingDepth,
                tailHash,
                via: "prefix",
                itemHashes: storedItemHashes,
            };
        }

        // 2. Tail-window reattach (#316 / PR-B): a client that dropped its
        //    oldest messages replays a retained suffix of the stored history
        //    (plus new appends), so the incoming's LEADING items must appear
        //    as a contiguous run somewhere inside the stored chain's item
        //    hashes — at any offset, not just the stored tail (a rolling-window
        //    client may retain more items than TAIL_WINDOW). Offset 0 is
        //    excluded: a head-to-head match is either a full-prefix case
        //    (step 1) or a distinct conversation sharing a templated head —
        //    never a truncation reattach (the retained suffix of a truncation
        //    starts strictly inside the stored chain).
        const w = Math.min(TAIL_WINDOW, incomingDepth);
        const candidates: ChainEntry[] = [];
        if (w >= MIN_TAIL_MATCH) {
            for (const entry of tracked.values()) {
                const stored = entry.itemHashes;
                for (let j = 1; j + w <= stored.length; j++) {
                    let match = true;
                    for (let i = 0; i < w; i++) {
                        if (incItemHashes[i] !== stored[j + i]) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        candidates.push(entry);
                        break;
                    }
                }
            }
        }
        if (candidates.length === 1) {
            const entry = candidates[0]!;
            const w = Math.min(TAIL_WINDOW, incomingDepth, entry.depth);
            return {
                sessionId: entry.sessionId,
                matchedDepth: w,
                storedDepth: entry.depth,
                incomingDepth,
                tailHash,
                via: "tail-window",
                itemHashes: storedItemHashes,
            };
        }

        // 3. New session, anchored deterministically on its current tail so an
        //    identical replay after a proxy restart reattaches the same id.
        //    Record lineage (UI/debug only) for the discarded candidates.
        let lineage: AnonymousAffinity["lineage"];
        if (candidates.length > 1) {
            lineage = { parents: candidates.map((c) => c.sessionId), reason: "truncated" };
        } else {
            let forkParent: ChainEntry | undefined;
            let forkLcp = 0;
            for (const entry of tracked.values()) {
                if (entry.depth > MAX_STORED_ITEMS) continue;
                const lcp = lcpLength(incItemHashes, entry.itemHashes);
                if (lcp >= MIN_FORK_PREFIX && lcp > forkLcp) {
                    forkLcp = lcp;
                    forkParent = entry;
                }
            }
            if (forkParent) lineage = { parents: [forkParent.sessionId], reason: "forked", sharedPrefix: forkLcp };
        }
        const sessionId = `pfa-${sha256(`${tailHash}\u0000${incomingDepth}`).slice(0, 16)}`;
        return {
            sessionId,
            matchedDepth: 0,
            storedDepth: 0,
            incomingDepth,
            tailHash,
            via: "new",
            itemHashes: storedItemHashes,
            ...(lineage ? { lineage } : {}),
        };
    }

    /** Record the chain of a session (on creation and after every anonymous
     *  request — the incoming history is the truth, appends extend it). */
    note(sessionId: string, depth: number, tailHash: string, itemHashes: string[]): void {
        const tracked = this.trackedChains;
        tracked.delete(sessionId);
        tracked.set(sessionId, { sessionId, depth, tailHash, itemHashes, lastSeen: Date.now() });
        while (tracked.size > MAX_TRACKED_SESSIONS) {
            const oldest = [...tracked.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!oldest) break;
            tracked.delete(oldest.sessionId);
        }
    }

    /** Drop tracking for a removed session. */
    forget(sessionId: string): void {
        this.trackedChains.delete(sessionId);
    }

    trackedSessionIds(): string[] {
        return [...this.trackedChains.keys()];
    }

    /** Serializable copy of the tracked chains (for #499 P1a persistence). */
    exportSnapshot(): AffinitySnapshotEntry[] {
        return [...this.trackedChains.values()].map((e) => ({
            sessionId: e.sessionId,
            depth: e.depth,
            tailHash: e.tailHash,
            itemHashes: e.itemHashes,
            lastSeen: e.lastSeen,
        }));
    }

    /** Load chains persisted by a previous process. Entries older than the
     *  TTL are dropped (they would not match anyway). Returns the count
     *  actually imported. Defensive: a corrupt/hand-edited file must never
     *  crash the proxy — malformed entries are skipped. */
    importSnapshot(entries: unknown): number {
        if (!Array.isArray(entries)) return 0;
        const now = Date.now();
        let imported = 0;
        for (const raw of entries) {
            if (!raw || typeof raw !== "object") continue;
            const e = raw as Record<string, unknown>;
            if (typeof e.sessionId !== "string" || typeof e.depth !== "number" || typeof e.tailHash !== "string") continue;
            if (!Array.isArray(e.itemHashes) || e.itemHashes.some((h) => typeof h !== "string")) continue;
            if (typeof e.lastSeen !== "number" || now - e.lastSeen > TTL_MS) continue;
            const entry: ChainEntry = {
                sessionId: e.sessionId,
                depth: e.depth,
                tailHash: e.tailHash,
                itemHashes: (e.itemHashes as string[]).slice(-MAX_STORED_ITEMS),
                lastSeen: e.lastSeen,
            };
            this.trackedChains.delete(entry.sessionId);
            this.trackedChains.set(entry.sessionId, entry);
            imported++;
        }
        while (this.trackedChains.size > MAX_TRACKED_SESSIONS) {
            const oldest = [...this.trackedChains.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!oldest) break;
            this.trackedChains.delete(oldest.sessionId);
        }
        return imported;
    }

    private expire(tracked: Map<string, ChainEntry>): void {
        if (tracked.size === 0) return;
        const now = Date.now();
        for (const [id, entry] of tracked) {
            if (now - entry.lastSeen > TTL_MS) tracked.delete(id);
        }
    }
}

/** Shared resolver instance (per proxy process). */
export const prefixAffinity = new PrefixAffinityResolver();
