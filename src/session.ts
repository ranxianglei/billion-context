import { createInitialState, type CompressionState } from "acp-kernel";

export type Session = {
    id: string;
    state: CompressionState;
    createdAt: number;
    lastSeen: number;
    requests: number;
    condensedToolResults: number;
    tokensSaved: number;
    /** Original content of compressed blocks, captured at compress time when
     *  the source messages are still present in the request. decompress reads
     *  from here instead of scanning ctx.messages (which only holds the
     *  post-compression / folded view and loses originals across rounds). */
    blockContents: Map<string, { text: string; count: number }>;
};

// KNOWN LIMITATION: sessions live in process memory. A proxy restart (deploy /
// crash) drops all compression state — clients then re-send full history and
// compression rebuilds from scratch (correct, but wasteful). Multi-instance
// deployments do NOT share state either.
// TODO: persist state to disk (atomic temp+rename) on a debounce and reload on
// boot, keyed by session id. Requires verifying CompressionState is fully
// JSON-serializable (no Maps/Sets that lose on round-trip).
// Session id defaults to a hash of the first user message (deriveSessionId*),
// so two clients with the same opener collide into one state. Multi-tenant
// deployments MUST send an explicit x-acp-session header to partition.
const sessions = new Map<string, Session>();

const MAX_SESSIONS = 256;

export function getSession(id: string): Session {
    const existing = sessions.get(id);
    if (existing) {
        existing.lastSeen = Date.now();
        return existing;
    }
    if (sessions.size >= MAX_SESSIONS) evictOldest();
    const session: Session = {
        id,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        requests: 0,
        condensedToolResults: 0,
        tokensSaved: 0,
        blockContents: new Map(),
    };
    sessions.set(id, session);
    return session;
}

export function listSessions(): Session[] {
    return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

function evictOldest(): void {
    let oldestId: string | undefined;
    let oldestSeen = Infinity;
    for (const [id, s] of sessions) {
        if (s.lastSeen < oldestSeen) {
            oldestSeen = s.lastSeen;
            oldestId = id;
        }
    }
    if (oldestId) sessions.delete(oldestId);
}
