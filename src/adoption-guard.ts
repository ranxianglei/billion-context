/**
 * Hot-adoption refusal (#394/#5624). Sharing one sessions dir across bili
 * instances is the supported topology (#5082/#5091), but two LIVE instances
 * writing the SAME session is the split-brain state: the sessions-row upsert
 * is last-writer-wins, so alternating writers produce digest drift and a
 * frozen envelope. served-markers.ts already DETECTS that state (#3923);
 * this module turns the same evidence into a REFUSAL at the two
 * inference-driven adoption points — anonymous prefix-affinity binding
 * (src/prefix-affinity.ts) and the plugin management plane's disk adoption
 * (src/plugin.ts resolveForkConversation + proxy-tool execution). A session
 * a live peer committed within CONTEST_WINDOW_MS is not adopted or written
 * here; the anonymous request mints its own fresh session instead and
 * management calls get an honest error naming the peer. Client-named ids
 * (conversation headers, prompt_cache_key) are deliberately NOT refused:
 * the client chose that session for this proxy and interleaved turns are
 * the owner-ruled supported topology (tests/multi-instance-live.test.ts) —
 * the drift alarm + freeze remain the containment there. The guard is
 * liveness-scoped: after a peer exits (stoppedAt/disposedAt stamped, pid
 * dead, marker stale) its sessions are adoptable again, so restart handoff
 * (#4626) keeps working. Unwired (no probe set — e.g. the inline engine,
 * which carries no writer markers) reads as "no contested writers" and
 * adoption proceeds exactly as before.
 */
import { findContestedWriters, type WriterIdentity } from "./served-markers.js";

export type HotWriter = WriterIdentity & { servedAt: number };

let probe: ((sessionId: string) => HotWriter[]) | undefined;

/** The probe the server wires where the marker dir and its own identity
 *  live (src/server.ts, #3923 block). Exported for tests. */
export function hotAdoptionProbe(dir: string, selfInstanceId: string): (sessionId: string) => HotWriter[] {
    return (sessionId) => findContestedWriters(dir, selfInstanceId, sessionId, Date.now());
}

export function setHotAdoptionProbe(p: ((sessionId: string) => HotWriter[]) | undefined): void {
    probe = p;
}

/** Live peers actively writing `sessionId` ([] when unwired or uncontested). */
export function hotWritersOf(sessionId: string): HotWriter[] {
    return probe?.(sessionId) ?? [];
}

/** Boolean refuser for PrefixAffinityResolver.resolve (undefined when
 *  unwired, so the resolver skips the callback cost entirely). */
export function hotAdoptionRefuser(): ((sessionId: string) => boolean) | undefined {
    if (!probe) return undefined;
    return (sessionId) => probe!(sessionId).length > 0;
}

export function describeHotWriter(w: HotWriter): string {
    const lane = w.lane ? ` ${w.lane} lane` : "";
    return `instance ${w.instanceId} (pid ${w.pid}${lane})`;
}
