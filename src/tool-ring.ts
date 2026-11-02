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

// ── #4580: tool_use id → session ring ────────────────────────────────────────
// Claude Code (≥2.1.308) stamps every MCP tools/call with the originating
// tool_use id (_meta["claudecode/toolUseId"]) — including calls made by Task
// subagents, whose traffic streams through a DIFFERENT proxy session (lane)
// than the conversation the shared MCP shim bound at startup. The (name,
// args) witness hash cannot tell them apart (subagent compresses can collide
// with the parent's or be absent from the parent's ring entirely), but the
// proxy witnessed each tool_use id in exactly one session's response stream.
// Host-stamped ids therefore route with the same authority as #2024 native
// caller ids. The ring is observe-only: recording never touches forwarded
// bytes, and an id absent from the ring simply falls back to the existing
// routing ladder — fail-closed semantics are unchanged.

/** Same staleness budget as the hash ring: a tools/call POST follows its
 *  tool_use within seconds; ten minutes tolerates a stuck host. */
const TOOL_USE_ID_TTL_MS = 10 * 60 * 1000;
/** Ids are ~30 bytes; a generous cap keeps pathological streams bounded. */
const TOOL_USE_ID_CAPACITY = 1024;

/** tool_use id → { sessionId, at }. Last write wins: host-issued ids are
 *  unique per call, so a re-record is a retry/replay, and the most recent
 *  stream position names the live lane. */
const toolUseIds = new Map<string, { sessionId: string; at: number }>();

/** Record that `sessionId`'s response stream carried a tool call bearing this
 *  host id (anthropic tool_use `id`, openai `tool_calls[].id`, responses
 *  `function_call.call_id`). Called from the same settle paths as
 *  recordToolWitness. */
export function recordToolUseId(toolUseId: string, sessionId: string): void {
    if (toolUseId.length === 0 || toolUseId.length > 512) return;
    toolUseIds.set(toolUseId, { sessionId, at: nowMs() });
    while (toolUseIds.size > TOOL_USE_ID_CAPACITY) {
        // Evict the entry with the smallest recorded time. Full scan — the cap
        // is tiny and this only runs past it. A re-record keeps its insertion
        // slot but refreshes `at`, so position order is NOT age order (a
        // first-inserted id can be the freshest one in the ring).
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [k, v] of toolUseIds) {
            if (v.at < oldestAt) {
                oldestAt = v.at;
                oldestKey = k;
            }
        }
        // Never evict what this call just wrote (clock went backwards): leave
        // the ring one over the cap until a normal insert can evict someone else.
        if (oldestKey === undefined || oldestKey === toolUseId) break;
        toolUseIds.delete(oldestKey);
    }
}

/** The session whose stream carried this tool_use id, or undefined when the
 *  id never streamed through this proxy (restart), or its entry expired. */
export function lookupToolUseIdSession(toolUseId: string): string | undefined {
    if (toolUseId.length === 0 || toolUseId.length > 512) return undefined;
    const hit = toolUseIds.get(toolUseId);
    if (!hit) return undefined;
    if (nowMs() - hit.at > TOOL_USE_ID_TTL_MS) {
        toolUseIds.delete(toolUseId);
        return undefined;
    }
    return hit.sessionId;
}

export function resetToolRingForTest(): void {
    rings.clear();
    hashIndex.clear();
    toolUseIds.clear();
    clockForTest = undefined;
}

/** #1685 review: TTL is an issue acceptance item — pin it with a fake clock. */
export function _setToolRingClockForTest(fn: (() => number) | undefined): void {
    clockForTest = fn;
}

export function _toolRingSizeForTest(): number {
    return rings.size;
}
