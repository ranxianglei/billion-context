import { createHash } from "node:crypto";
import { stableStringify } from "./prefix-affinity.js";

/**
 * #1685 zero-injection session identity — outbound tool_use witness ring.
 *
 * The model no longer sees any conversation id (no system note, no
 * conversation_id tool parameter, no tail note): the wire stays byte-stable so
 * fork/`--continue` inherit the upstream prefix cache 100% (#1611). A shared
 * MCP shim that cannot derive a conversation id still needs its
 * POST /__bili/plugin/tool routed to the right session. The proxy is the only
 * path model output takes, so it WITNESSES every complete bili tool call as it
 * streams out (name + arguments). This ring keeps, per session, the last N
 * witnessed calls; an id-less POST is matched by hashing its (name, args) the
 * same way both sides do, and the witness names the session.
 *
 * Matching guarantees (issue #1685): a several-hundred-char free-text summary
 * is a unique anchor, so a compress hit identifies the session with certainty.
 * Collisions (two sessions replaying the same args) refuse to guess and fall
 * back to the caller-supplied id or single-active arbitration.
 */

const RING_CAPACITY = 32;
/** Witness staleness. A tool POST follows its tool_use within seconds; ten
 *  minutes tolerates a stuck host without unbounded memory. */
const WITNESS_TTL_MS = 10 * 60 * 1000;

interface WitnessEntry {
    hash: string;
    at: number;
}

/** sessionId → ring of recent witness hashes (oldest first, capped). */
const rings = new Map<string, WitnessEntry[]>();
/** witness hash → set of sessionIds holding it (populated on lookup sweep). */
const hashIndex = new Map<string, Set<string>>();

/** Fake-clock seam for TTL tests. Undefined = real wall clock. */
let clockForTest: (() => number) | undefined;

function nowMs(): number {
    return clockForTest ? clockForTest() : Date.now();
}

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `mcp__bili__compress`-style host-prefixed names (double underscore
 *  separators) normalize to the proxy tool name; bare names pass through
 *  unchanged. The same rule applies on both the record and the lookup side. */
export function normalizeToolName(name: string): string {
    const idx = name.lastIndexOf("__");
    return idx >= 0 ? name.slice(idx + 2) : name;
}

/** Canonical hash of a witnessed tool call. Both sides normalize the name,
 *  drop the legacy routing parameter (#760), and key-sort the arguments via
 *  stableStringify so host re-serialization order is irrelevant. */
export function witnessHash(name: string, args: unknown): string {
    let canonicalArgs = "{}";
    if (typeof args === "string") {
        const trimmed = args.trim();
        if (trimmed.length > 0) {
            try {
                canonicalArgs = stableStringify(JSON.parse(trimmed));
            } catch {
                return "";
            }
        }
    } else if (args !== null && args !== undefined) {
        canonicalArgs = stableStringify(args);
    }
    // Non-object argument JSON (a null/scalar from a misbehaving upstream) has
    // no keys to route by — reject instead of throwing inside the stream path.
    const parsed = JSON.parse(canonicalArgs);
    if (parsed === null || typeof parsed !== "object") return "";
    const obj = parsed as Record<string, unknown>;
    if ("conversation_id" in obj) {
        delete obj.conversation_id;
        canonicalArgs = stableStringify(obj);
    }
    return sha256(`${normalizeToolName(name)}\0${canonicalArgs}`);
}

function dropFromIndex(hash: string, sessionId: string): void {
    const sessions = hashIndex.get(hash);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) hashIndex.delete(hash);
}

/** Drop index membership ONLY when no surviving ring slot still carries this
 *  hash. A duplicate hash inside the window (same name+args witnessed twice —
 *  e.g. a retried compress) must not lose its index when its OLDER copy is
 *  evicted or swept; that would silently demote the witness to a miss.
 *  O(capacity) per eviction — negligible at 32. */
function dropFromIndexIfAbsent(ring: WitnessEntry[], hash: string, sessionId: string): void {
    if (ring.some((e) => e.hash === hash)) return;
    dropFromIndex(hash, sessionId);
}

function sweep(sessionId: string, now: number): void {
    const ring = rings.get(sessionId);
    if (!ring) return;
    while (ring.length > 0 && now - ring[0].at > WITNESS_TTL_MS) {
        const dead = ring.shift();
        if (!dead) break;
        dropFromIndexIfAbsent(ring, dead.hash, sessionId);
    }
    if (ring.length === 0) rings.delete(sessionId);
}

/** Record that `sessionId`'s response stream carried a complete tool call.
 *  Called from the plugin response pipes (the only path model output takes)
 *  once a call's name and full arguments are known. */
export function recordToolWitness(sessionId: string, name: string, args: string | Record<string, unknown>): void {
    if (name.length === 0) return;
    const hash = witnessHash(name, args);
    if (!hash) return;
    const now = nowMs();
    sweep(sessionId, now);
    const ring = rings.get(sessionId) ?? [];
    if (ring.length > 0 && ring[ring.length - 1].hash === hash) {
        ring[ring.length - 1].at = now;
    } else {
        ring.push({ hash, at: now });
        // capacity eviction must drop the index entry too, or hashIndex keeps
        // every over-capacity hash forever (unbounded growth + stale hits) —
        // but only when no surviving slot still carries the hash (duplicates).
        while (ring.length > RING_CAPACITY) {
            const evicted = ring.shift();
            if (!evicted) break;
            dropFromIndexIfAbsent(ring, evicted.hash, sessionId);
        }
    }
    rings.set(sessionId, ring);
    const sessions = hashIndex.get(hash) ?? new Set<string>();
    sessions.add(sessionId);
    hashIndex.set(hash, sessions);
}

/** Sessions whose recent witnessed calls match this (name, args). Empty when
 *  nothing matches (proxy restart, TTL expiry, or the call never streamed
 *  through this proxy). */
export function lookupToolWitness(name: string, args: unknown): Set<string> {
    const hash = witnessHash(name, args);
    if (!hash) return new Set();
    const now = nowMs();
    for (const sessionId of [...rings.keys()]) sweep(sessionId, now);
    const sessions = hashIndex.get(hash);
    return sessions ? new Set(sessions) : new Set();
}

export function resetToolRingForTest(): void {
    rings.clear();
    hashIndex.clear();
    clockForTest = undefined;
}

/** #1685 review: TTL is an issue acceptance item — pin it with a fake clock. */
export function _setToolRingClockForTest(fn: (() => number) | undefined): void {
    clockForTest = fn;
}

export function _toolRingSizeForTest(): number {
    return rings.size;
}
