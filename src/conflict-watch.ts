// #1206: per-session compression-conflict ledger. Every piece of evidence that
// another compressor (third-party plugin, client native compaction) touched
// this conversation lands here so the user can SEE it (acp_status / web UI /
// stats) instead of finding out later from scrambled context. Bounded ring —
// the ledger is diagnostic, not history.

import { markDirty, type Session } from "./session.js";

export type ConflictKind = "third-party-plugin" | "unannounced-rewrite" | "orphan-reap" | "native-compaction";

export interface ConflictEvent {
    at: number;
    kind: ConflictKind;
    detail: string;
}

export const CONFLICT_LEDGER_MAX = 20;

export function conflictEventsOf(session: Session): ConflictEvent[] {
    const raw = session.metadata.conflictEvents;
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is ConflictEvent =>
        !!e && typeof e === "object" &&
        typeof (e as ConflictEvent).at === "number" &&
        typeof (e as ConflictEvent).kind === "string" &&
        typeof (e as ConflictEvent).detail === "string",
    );
}

export function recordConflict(session: Session, kind: ConflictKind, detail: string): void {
    const events = conflictEventsOf(session);
    events.push({ at: Date.now(), kind, detail });
    while (events.length > CONFLICT_LEDGER_MAX) events.shift();
    session.metadata.conflictEvents = events;
    markDirty(session);
}

function fmtTime(at: number): string {
    return new Date(at).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function isSuspectedEvent(e: ConflictEvent): boolean {
    return e.kind === "third-party-plugin" && e.detail.endsWith("[suspected]");
}

export function formatConflictSection(events: ConflictEvent[]): string[] {
    const lines: string[] = [];
    lines.push(`COMPRESSION CONFLICTS — ${events.length} event(s) in this session. Two compressors on one conversation (bili + a third-party compression plugin or client native compaction) double-compress and corrupt message refs:`);
    for (const e of events.slice(-10)) {
        lines.push(`  [${fmtTime(e.at)}] ${e.kind} — ${e.detail}`);
    }
    if (events.length > 10) lines.push(`  … ${events.length - 10} earlier event(s); full list: GET /__bili/stats → conflicts`);
    // #1736: the [suspected] tier is a name-only guess, not observed evidence —
    // say so, and don't command removal when nothing confirmed was found.
    const suspectedCount = events.filter(isSuspectedEvent).length;
    if (suspectedCount > 0) {
        lines.push("  [suspected] = name-only keyword match — verify the plugin actually compresses before acting; a context dashboard/viewer/tool is NOT a compressor.");
    }
    const allSuspected = suspectedCount > 0 && suspectedCount === events.length;
    lines.push(allSuspected
        ? "Every event above is [suspected]: confirm each named plugin really compresses before removing anything — do not drop a read-only tool on the strength of its name."
        : "Keep exactly ONE compressor per conversation: remove/disable the other plugin (or its native auto-compaction), then start a fresh session.");
    return lines;
}

export interface ConflictSummary {
    sessions: number;
    events: number;
    kinds: Partial<Record<ConflictKind, number>>;
    latest: Array<{ sessionId: string; at: number; kind: ConflictKind; detail: string }>;
}

export function summarizeConflicts(sessions: Session[]): ConflictSummary {
    const summary: ConflictSummary = { sessions: 0, events: 0, kinds: {}, latest: [] };
    for (const s of sessions) {
        const events = conflictEventsOf(s);
        if (events.length === 0) continue;
        summary.sessions += 1;
        summary.events += events.length;
        for (const e of events) summary.kinds[e.kind] = (summary.kinds[e.kind] ?? 0) + 1;
        const last = events[events.length - 1]!;
        summary.latest.push({ sessionId: s.id, at: last.at, kind: last.kind, detail: last.detail });
    }
    summary.latest.sort((a, b) => b.at - a.at);
    return summary;
}
