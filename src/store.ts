import type { CoreMessage } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import type { PendingRetrieval, Session } from "./session.js";

// #3400: per-request stamp of the acp_read_original_image TOOL registration gate.
// The rescale PASS itself runs on every lane (governed by the BILI_IMAGE_RESCALE
// knob); only the manifest registration and the annotation's invocation entry
// follow this stamp — codex/plugin lanes get size-only notes.
const EFFECTIVE_IMAGE_RESCALE_KEY = "effectiveImageRescale";

/** Stamp whether acp_read_original_image may be registered for this session's
 *  lane (per-request). */
export function storeEffectiveImageRescale(session: Session, armed: boolean | undefined): void {
    // Absent == not armed (imageRescaleToolArmed reads === true). Writing only the
    // armed state keeps non-armed lanes' metadata byte-identical to pre-#3400
    // (storage-render digests pin that shape).
    if (armed === true) session.metadata[EFFECTIVE_IMAGE_RESCALE_KEY] = true;
    else delete session.metadata[EFFECTIVE_IMAGE_RESCALE_KEY];
}

/** Read back the #3400 tool-registration stamp. */
export function imageRescaleToolArmed(session: Session | undefined): boolean {
    return session?.metadata[EFFECTIVE_IMAGE_RESCALE_KEY] === true;
}

// Some session paths (and test harnesses) leave the in-memory carrier unset;
// treat an absent carrier as empty rather than crash. Writers assign a defined
// array. The carrier serves request-only injections (range restore #1207).
function carrierOf(session: Session): PendingRetrieval[] {
    return session.pendingRetrievals ?? [];
}

/** Snapshot the currently-queued items WITHOUT removing them. Plugin-lane
 *  prepares attach these to the outgoing request; the items stay in the queue
 *  until commit/drop, so an overflow-refold re-prepare re-sends them and a
 *  concurrent same-session request is resolved by ref-set filtering. */
export function snapshotPendingRetrievals(session: Session): PendingRetrieval[] {
    return carrierOf(session).slice();
}

/** Confirmed upstream success: remove the delivered refs from the carrier.
 *  Idempotent (a concurrent prior removal is a no-op). */
export function commitRetrievals(session: Session, refs: Iterable<string>): void {
    const requested = [...new Set(refs)];
    if (requested.length === 0) return;
    const reqSet = new Set(requested);
    const carrier = carrierOf(session);
    if (!carrier.some((p) => reqSet.has(p.ref))) return;
    session.pendingRetrievals = carrier.filter((p) => !reqSet.has(p.ref));
}

/** Undelivered loss: remove the refs from the carrier and log refs+count+
 *  reason at warn. Idempotent. */
export function dropRetrievals(session: Session, refs: Iterable<string>, reason: string): void {
    const requested = [...new Set(refs)];
    if (requested.length === 0) return;
    const reqSet = new Set(requested);
    const carrier = carrierOf(session);
    const lost = carrier.filter((p) => reqSet.has(p.ref));
    if (lost.length === 0) return;
    session.pendingRetrievals = carrier.filter((p) => !reqSet.has(p.ref));
    const tok = lost.reduce((s, p) => s + p.tokens, 0);
    loggerLog("warn", `${lost.length} injection carrier(s) not delivered (${reason}): ${lost.map((p) => p.ref).join(", ")}${tok ? ` (${tok} tok)` : ""}`);
}

/** Proxy-mode drain: the injection is composed within ONE response flow (no
 *  cross-request window), so draining commits delivery immediately. */
export function drainPendingRetrievals(session: Session): CoreMessage[] {
    const items = carrierOf(session).slice();
    if (items.length === 0) return [];
    session.pendingRetrievals = [];
    commitRetrievals(session, items.map((i) => i.ref));
    return items.map((i) => i.injection);
}
