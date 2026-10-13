// #2935: explicit per-session artifact teardown, driven by a host-side
// conversation deletion (dsh / other agents via POST /__bili/plugin/delete).
// Single owner of the "remove every artifact bound to one session id" routine
// so all callers tear down the same complete set (session file + CCR store +
// image spill + unified rows + resident memory + prefix-affinity).
import { rm } from "node:fs/promises";
import { dropSessionForGc, peekSession } from "./session.js";
import { getStore } from "./persist.js";
import { restoreExportDir } from "./image-restore.js";
import { prefixAffinity } from "./prefix-affinity.js";
import { log as loggerLog } from "./logger.js";

interface DeleteSessionOutcome {
    deleted: boolean;
    deferred: boolean;
    reason?: string;
}

/** Persona forks live under `<baseId>|sub:<fp>` (session-id.ts
 *  subagentNamespace anchor semantics): pure derivatives of one conversation,
 *  so they die with it. Independent child conversations (opencode subagent /
 *  fork children) carry their OWN ids and are deliberately excluded here. */
export function personaForkIds(baseId: string, sessions: Iterable<{ id: string }>): string[] {
    const prefix = `${baseId}|sub:`;
    const out: string[] = [];
    for (const s of sessions) if (s.id.startsWith(prefix)) out.push(s.id);
    return out;
}

/** Remove every artifact bound to one resident-or-persisted session id.
 *  Defers (does not delete) while a request is in-flight or a debounced save
 *  is armed — removing the file under an active writer would resurrect it on
 *  the next flush; the caller's next trigger retries once idle. */
export async function deleteSessionArtifacts(sessionId: string): Promise<DeleteSessionOutcome> {
    const store = getStore();
    const resident = peekSession(sessionId);
    if (resident && (resident.inFlight > 0 || store.hasPending(sessionId))) {
        loggerLog("info", `[session-delete] deferring ${sessionId}: in-flight or pending save`);
        return { deleted: false, deferred: true, reason: "busy" };
    }
    if (resident) dropSessionForGc(sessionId);
    if (store.enabled) {
        await store.removeSessionFiles(
            sessionId,
            resident ? { protocol: resident.meta.protocol, upstreamOrigin: resident.meta.upstreamOrigin } : undefined,
        );
    }
    try {
        await rm(restoreExportDir(sessionId), { recursive: true, force: true });
    } catch (err) {
        loggerLog("warn", `[session-delete] image-spill cleanup failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    prefixAffinity.forget(sessionId);
    loggerLog("info", `[session-delete] removed artifacts for ${sessionId}`);
    return { deleted: true, deferred: false };
}
