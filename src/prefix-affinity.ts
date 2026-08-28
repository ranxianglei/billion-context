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
}

interface ChainEntry {
    sessionId: string;
    depth: number;
    tailHash: string;
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
        const tailHash = hashes[hashes.length - 1]!;
        const tracked = this.trackedChains;
        this.expire(tracked);

        let best: ChainEntry | undefined;
        for (const entry of tracked.values()) {
            if (entry.depth > hashes.length) continue;
            if (hashes[entry.depth - 1] !== entry.tailHash) continue;
            if (!best || entry.depth > best.depth || (entry.depth === best.depth && entry.lastSeen > best.lastSeen)) best = entry;
        }

        if (best) {
            return {
                sessionId: best.sessionId,
                matchedDepth: best.depth,
                storedDepth: best.depth,
                incomingDepth: hashes.length,
                tailHash,
            };
        }

        // No stored chain is a prefix of the incoming history: this request
        // starts a session, anchored deterministically on its current tail so
        // an identical replay after a proxy restart reattaches the same id.
        const sessionId = `pfa-${sha256(`${tailHash}\u0000${hashes.length}`).slice(0, 16)}`;
        return { sessionId, matchedDepth: 0, storedDepth: 0, incomingDepth: hashes.length, tailHash };
    }

    /** Record the chain of a session (on creation and after every anonymous
     *  request — the incoming history is the truth, appends extend it). */
    note(sessionId: string, depth: number, tailHash: string): void {
        const tracked = this.trackedChains;
        tracked.delete(sessionId);
        tracked.set(sessionId, { sessionId, depth, tailHash, lastSeen: Date.now() });
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
