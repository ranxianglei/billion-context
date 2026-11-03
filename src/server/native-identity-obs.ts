// #5571 M1 (observation layer): per-session native identity state + the
// fail-open collection call.
//
// Red lines (see issue #5571 M1 design):
//  - zero forwarded-byte changes: this module reads only;
//  - zero decisions: nothing downstream may gate on this data until M2/M3;
//  - privacy: session ext stores sha1-8 digests of id values, never raw ids;
//    logs print digests/truncations only;
//  - default OFF (rollout.features.nativeIdentityObservation, percent 0);
//  - unknown clients leave NO ext values at all (count-only, see profiles);
//  - size hygiene: the whole ext blob is hard-capped (events FIFO-trimmed),
//    same discipline as the gc-vacuum era.
import crypto from "node:crypto";
import { featureEnabled } from "../rollout.js";
import { getStore } from "../persist.js";
import { detectNativeProfile, extractNativeIdentity, type NidvObservation, type NidvClientId } from "./native-identity-profiles.js";

export const NIDV_EXT_KEY = "nidv:obs";
const MAX_JSON_BYTES = 4096;
const MAX_EVENTS = 32;
const EV_TEXT_CAP = 64;

export interface NidvEvent {
    t: number;
    /** compaction | id_change | profile_flip | dual_mismatch | shape_assert_fail */
    k: string;
    /** ≤64 chars of evidence (prefix text / header name / marker). */
    e: string;
}

export interface NidvState {
    v: 1;
    client: NidvClientId;
    firstSeen: number;
    lastSeen: number;
    reqs: number;
    sessH?: string;
    sessStable: "unknown" | "yes" | "no";
    msgN?: number;
    msgLastH?: string;
    events: NidvEvent[];
}

/** sha1 first 8 hex — digest form stored in ext / printed in logs. */
export function nidvH8(value: string): string {
    return crypto.createHash("sha1").update(value, "utf8").digest("hex").slice(0, 8);
}

/** Pure state transition: fold one request observation into prior state.
 *  Unit-tested directly (stability matrix incl. restart continuity). */
export function mergeNidvState(prev: NidvState | null, obs: NidvObservation, now: number): NidvState {
    const next: NidvState = prev
        ? { ...prev, events: [...prev.events] }
        : { v: 1, client: obs.profileId, firstSeen: now, lastSeen: now, reqs: 0, sessStable: "unknown", events: [] };
    next.lastSeen = now;
    next.reqs += 1;
    const pushEvent = (k: string, e: string) => {
        const ev: NidvEvent = { t: now, k, e: e.slice(0, EV_TEXT_CAP) };
        const last = next.events[next.events.length - 1];
        if (last && last.k === k && last.e === ev.e) return; // consecutive dedupe
        next.events.push(ev);
        while (next.events.length > MAX_EVENTS) next.events.shift();
    };

    if (obs.profileId !== next.client) {
        // Client family changed under one bili session id — incident class.
        pushEvent("profile_flip", `${next.client}->${obs.profileId}`);
        next.client = obs.profileId;
    }

    // Session channel stability (same-value repeats → yes, any change → no).
    if (typeof obs.sessVal === "string") {
        const h = nidvH8(obs.sessVal);
        if (next.sessH === undefined) {
            next.sessH = h;
            next.sessStable = "yes"; // single sighting: assume stable until proven otherwise
        } else if (h !== next.sessH) {
            next.sessH = h;
            next.sessStable = "no";
            pushEvent("id_change", `sess ${h}`);
        }
    }
    // Cross-channel verification (cc metadata vs header). Evidence carries
    // DIGESTS of both channels — a raw id must never reach the persisted blob.
    if (typeof obs.dualBodySessVal === "string" && typeof obs.sessVal === "string") {
        const hHdr = nidvH8(obs.sessVal);
        const hBody = nidvH8(obs.dualBodySessVal);
        if (hHdr !== hBody) pushEvent("dual_mismatch", `hdr=${hHdr} body=${hBody}`);
    }
    // Message-level host id (wb today): per-request id changes every turn by
    // design — we track LAST value + sighting count; M2's binding table turns
    // this into the tail slot.
    if (typeof obs.msgVal === "string") {
        const h = nidvH8(obs.msgVal);
        next.msgN = (next.msgN ?? 0) + 1;
        next.msgLastH = h;
    }
    // Re-baseline signals — the core M3 data asset starts here.
    if (obs.compactionSignal) pushEvent("compaction", `${obs.compactionSignal}:${obs.compactionEvidence ?? ""}`);
    if (obs.shapeAssertFail) pushEvent("shape_assert_fail", obs.shapeAssertFail);

    // Hard size budget: trim oldest events until the blob fits.
    while (JSON.stringify(next).length > MAX_JSON_BYTES && next.events.length > 1) next.events.shift();
    return next;
}

/** Minimal structural store view — production callers pass nothing (module
 *  singleton via getStore()); tests inject a duck to exercise the write path
 *  without a real sidecar. */
export interface NidvStoreView {
    replicasAvailable(): boolean;
    getSessionExt(sessionId: string, key: string): unknown;
    setSessionExt(sessionId: string, key: string, value: unknown): void;
}

export interface ObserveNativeIdentityArgs {
    sessionId: string;
    headers: Record<string, unknown>;
    urlPath: string;
    protocol: string | null;
    bodyText?: string;
    parsedBody?: unknown;
    log: (level: string, msg: string) => void;
    /** Test seam: force on/off regardless of rollout (undefined = read flag). */
    enabled?: boolean;
    /** Test seam: storage view override (undefined = module singleton). */
    store?: NidvStoreView;
}

/** Single observation call site target (wired at src/server/handle.ts after
 *  sessionId binding). Synchronous, fail-open, default off. Must never throw
 *  into the request path. */
export function observeNativeIdentity(args: ObserveNativeIdentityArgs): void {
    try {
        if (!args.sessionId) return;
        const enabled = args.enabled ?? featureEnabled("nativeIdentityObservation");
        if (!enabled) return; // off = ZERO writes, byte-identical pipeline
        const store = args.store ?? getStore();
        if (!store.replicasAvailable()) return;
        const profile = detectNativeProfile(args.headers, args.urlPath, args.protocol);
        const obs = extractNativeIdentity(profile, args.headers, args.urlPath, args.protocol, args.parsedBody, args.bodyText);
        if (profile.id === "unknown") return; // privacy redline: no values for unknown clients
        const prevRaw = store.getSessionExt(args.sessionId, NIDV_EXT_KEY);
        let prev: NidvState | null = null;
        if (typeof prevRaw === "string" && prevRaw.length > 0) {
            try {
                const p = JSON.parse(prevRaw) as NidvState;
                if (p && p.v === 1 && Array.isArray(p.events)) prev = p;
            } catch { /* corrupt prev: rebuild fresh */ }
        }
        const next = mergeNidvState(prev, obs, Date.now());
        store.setSessionExt(args.sessionId, NIDV_EXT_KEY, JSON.stringify(next));
        const evtPart = obs.compactionSignal ? ` evt=compaction(${obs.compactionSignal}:${obs.compactionEvidence ?? ""})` : "";
        args.log(
            obs.compactionSignal ? "warn" : "debug",
            `nidv: client=${next.client} sess=${next.sessH ?? "-"} reqs=${next.reqs}${evtPart}`,
        );
    } catch {
        /* fail-open: observation must never affect the request below it */
    }
}
