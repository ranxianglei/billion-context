import { createInitialState, type CompressionState } from "acp-kernel";

export type Session = {
    id: string;
    state: CompressionState;
    createdAt: number;
    lastSeen: number;
    requests: number;
    condensedToolResults: number;
    tokensSaved: number;
};

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
