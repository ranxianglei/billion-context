/**
 * #5573 M1 (L1) — native-identity observation core. Pure OBSERVATION:
 * records what identity evidence the host actually sent (headers, bounded
 * body signals, compaction prefaces) into the session ext store plus a log
 * line. It feeds NO decision — request handling, folding, parsing and
 * outbound bytes are untouched by construction (red lines: zero upstream
 * mutation, zero decisions, zero agent-side changes; off-or-unknown traffic
 * produces zero diff against the existing golden suites).
 *
 * Privacy red line (#5573 M1 design): id VALUES never persist or log in
 * plaintext — ext stores sha1-8 digests only, log lines print the 8-char
 * digest + ellipsis. Full values live in memory for the duration of the
 * request lifecycle at most (used for the dual-channel cross-check).
 *
 * Cost discipline: header extraction is constant-time; body signals use
 * bounded indexOf walks over the ALREADY-decoded bytes (no JSON.parse — the
 * chokepoint holds bytes, and parsing is exactly the work #5403 removed).
 * Profiles without body signals never touch the body at all. The whole call
 * is fail-open: any internal error drops the observation, never the request.
 */

import { createHash } from "node:crypto";
import type { SessionStore } from "../persist.js";
import { resolveNativeIdProfile } from "./native-identity-profiles.js";
import type { NativeIdProfileDef } from "./native-identity-profiles.js";

export const NIDV_EXT_KEY = "nidv:obs";

const EVENT_CAP = 32;
const RING_CAP = 64;
const EXT_BUDGET = 4096;
/** Bounded backward distance for enclosing-role attribution of a prefix hit. */
const ROLE_WINDOW = 262_144;
/** Top-level body fields live near the head; bounded walk window. */
const TOP_FIELD_WINDOW = 8192;
/** Incident-class events escalate the line to WARN (owner spec: compaction
 *  hits are the headline signal M2/L2a consumes). */
const WARN_EVENTS = new Set(["compaction", "dual_mismatch", "shape_assert_fail"]);

export interface NidvEvent {
    t: number;
    k: string;
    e?: string;
}

export interface NidvMsgStats {
    n: number;
    /** Lower bound: unique digests inside the bounded recent ring. */
    distinct: number;
    /** yes = a digest repeated across turns (host reuses ids across retries);
     *  no = ≥8 turns observed, all distinct; unknown = not yet decidable. */
    stable: "unknown" | "yes" | "no";
    ring: string[];
}

export interface NidvObs {
    v: 1;
    client: string;
    firstSeen: number;
    lastSeen: number;
    reqs: number;
    ids: {
        sess?: { h: string; stable: "unknown" | "yes" | "no" };
        msg?: NidvMsgStats;
        prevRespH?: string;
    };
    events: NidvEvent[];
}

export interface NativeIdInput {
    /** Explicit record key (the plugin-lane site passes its conversationId —
     *  the host-native conversation id). When omitted (relay site) the key is
     *  DERIVED FROM THE PROFILE'S OWN SESSION EVIDENCE (`n:<sha1-8>`), not
     *  bili's identity chain: pre-#5526 the chain would key WorkBuddy traffic
     *  by the account-level x-session-id, merging every conversation of one
     *  account into one record and corrupting the stability stats. No session
     *  evidence ⇒ the shared "anon" bucket (coarse by design, documented).
     *  Deliberately NOT bili's internal session id either way — forks share
     *  the parent's client-visible key, which is what we are observing. */
    key?: string;
    headers: Record<string, string | string[] | undefined>;
    /** Decoded body bytes/text. May be omitted (then body signals are skipped). */
    body?: Buffer | string;
    protocol?: string | null;
    path?: string;
    /** Plugin-lane agent stamp (x-bili-plugin) — trusted identity, wins labeling. */
    agent?: string;
    /** Host msgid envelope parallel to the lane delta (#4491). */
    msgIds?: string[];
}

export interface NativeIdCount {
    label: string;
    n: number;
    assertZero?: boolean;
}

export interface NativeIdExtraction {
    client: string;
    profileName: string;
    sessH?: string;
    msgidH?: string;
    turnH?: string;
    edge?: string;
    level?: boolean;
    fork?: boolean;
    counts: NativeIdCount[];
    /** First compaction-preface hit with its enclosing-element attribution. */
    prefix?: { elemIdx: number; role: string; offset: number };
    dual?: "ok" | "mismatch" | "absent";
    prevRespH?: string;
    /** Message elements observed this turn (envelope length, else role-marker count). */
    delta: number;
    noteParts: string[];
}

export function digest8(value: string): string {
    return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 8);
}

function hdrValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const v = headers[name];
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
}

function countSub(s: string, sub: string): number {
    let n = 0;
    let i = s.indexOf(sub);
    while (i !== -1) {
        n += 1;
        i = s.indexOf(sub, i + sub.length);
    }
    return n;
}

/** Nearest preceding `"role":"<x>"` marker before offset o, plus the element
 *  index (count of role markers seen). Approximate by design: wire elements
 *  carry role first, nested role keys are not expected on model wires. A hit
 *  farther than ROLE_WINDOW behind o degrades to role "unknown" (honest). */
function roleAtOffset(s: string, o: number): { role: string; elemIdx: number } {
    const mark = '"role":';
    let idx = -1;
    let elemIdx = 0;
    let lastRole = "unknown";
    let lastAt = -1;
    while ((idx = s.indexOf(mark, idx + 1)) !== -1 && idx < o) {
        elemIdx += 1;
        let p = idx + mark.length;
        while (p < s.length && s[p] === " ") p += 1;
        if (s[p] === '"') {
            const e = s.indexOf('"', p + 1);
            if (e !== -1) lastRole = s.slice(p + 1, e);
        }
        lastAt = idx;
    }
    if (lastAt === -1 || o - lastAt > ROLE_WINDOW) return { role: "unknown", elemIdx };
    return { role: lastRole, elemIdx };
}

/** Quoted value following `key` (including its quotes), bounded to `window`
 *  chars past the key. Malformed shapes degrade to undefined (swallowed). */
function quotedValueAfter(s: string, key: string, window: number): string | undefined {
    const a = s.indexOf(key);
    if (a === -1) return undefined;
    const end = Math.min(s.length, a + window);
    let p = a + key.length;
    while (p < end && (s[p] === " " || s[p] === ":")) p += 1;
    if (p >= end || s[p] !== '"') return undefined;
    const e = s.indexOf('"', p + 1);
    if (e === -1 || e > end) return undefined;
    return s.slice(p + 1, e);
}

export function extractNativeIdentity(input: NativeIdInput): NativeIdExtraction | null {
    const profile: NativeIdProfileDef = resolveNativeIdProfile(input.headers, input.protocol);
    const client = input.agent ?? profile.name;
    if (client === "unknown") return null;

    const out: NativeIdExtraction = {
        client,
        profileName: profile.name,
        counts: [],
        delta: 0,
        noteParts: [],
    };

    const sessRaw = pickFirst(profile.sessionHeaders, input.headers, profile.sessionValuePrefix);
    if (sessRaw !== undefined) {
        out.sessH = digest8(sessRaw);
        out.dual = "absent";
    }
    const msgidRaw = pickFirst(profile.msgidHeaders, input.headers);
    if (msgidRaw !== undefined) out.msgidH = digest8(msgidRaw);
    const turnRaw = pickFirst(profile.turnHeaders, input.headers);
    if (turnRaw !== undefined) out.turnH = digest8(turnRaw);

    if (profile.compactionEdgeHeader !== undefined) {
        const v = hdrValue(input.headers, profile.compactionEdgeHeader);
        if (v !== undefined) out.edge = v.slice(0, 32);
    }
    if (profile.compactionLevelHeader !== undefined) {
        out.level = hdrValue(input.headers, profile.compactionLevelHeader) !== undefined;
    }
    if (input.agent === undefined && profile.turnHeaders.includes("x-parent-session-id")) {
        out.fork = hdrValue(input.headers, "x-parent-session-id") !== undefined;
    }
    for (const name of profile.fingerprintHeaders) {
        const v = hdrValue(input.headers, name);
        if (v !== undefined) out.noteParts.push(`fp:${name}=${v.slice(0, 24)}`);
    }

    if (input.msgIds !== undefined) {
        out.delta = input.msgIds.length;
    }

    const needsBody =
        profile.countPatterns.length > 0 ||
        profile.compactionPrefixes.length > 0 ||
        profile.dualSessionBodyAnchor !== undefined ||
        profile.rotationBodyField !== undefined;
    if (needsBody && input.body !== undefined) {
        const s = typeof input.body === "string" ? input.body : input.body.toString("utf8");
        if (out.delta === 0) out.delta = countSub(s, '"role":');

        for (const pat of profile.countPatterns) {
            const n = countSub(s, pat.pattern);
            out.counts.push({ label: pat.label, n, assertZero: pat.assertZero });
            if (pat.assertZero === true || n > 0) out.noteParts.push(`${pat.label}=${String(n)}`);
            if (pat.assertZero === true && n > 0) out.noteParts.push("assert-fail");
        }

        let best: { offset: number } | undefined;
        for (const pre of profile.compactionPrefixes) {
            const o = s.indexOf(pre);
            if (o !== -1 && (best === undefined || o < best.offset)) best = { offset: o };
        }
        if (best !== undefined) {
            const attr = roleAtOffset(s, best.offset);
            out.prefix = { elemIdx: attr.elemIdx, role: attr.role, offset: best.offset };
            if (attr.role !== "user") out.noteParts.push(`prefix@elem${String(attr.elemIdx)}/${attr.role}`);
        }

        if (profile.dualSessionBodyAnchor !== undefined && sessRaw !== undefined) {
            const a = profile.dualSessionBodyAnchor;
            const anchorPos = s.indexOf(a.anchor);
            let bodyVal: string | undefined;
            if (anchorPos !== -1) {
                const end = Math.min(s.length, anchorPos + a.window);
                const f = s.indexOf(a.field, anchorPos + a.anchor.length);
                if (f !== -1 && f < end) bodyVal = quotedValueAfter(s, a.field, end - f);
            }
            if (bodyVal === undefined) out.dual = "absent";
            else if (bodyVal === sessRaw) out.dual = "ok";
            else out.dual = "mismatch";
            out.noteParts.push(`dual=${out.dual}`);
        }

        if (profile.rotationBodyField !== undefined) {
            const v = quotedValueAfter(s, `"${profile.rotationBodyField}"`, TOP_FIELD_WINDOW);
            if (v !== undefined) out.prevRespH = digest8(v);
        }
    }

    if (out.edge !== undefined) out.noteParts.unshift(`compact=${out.edge}`);
    if (out.level === true) out.noteParts.push("ctx=yes");
    if (out.fork === true) out.noteParts.push("fork=yes");
    return out;
}

function pickFirst(
    names: readonly string[],
    headers: Record<string, string | string[] | undefined>,
    valuePrefix?: string,
): string | undefined {
    for (const name of names) {
        const v = hdrValue(headers, name);
        if (v === undefined) continue;
        if (valuePrefix !== undefined && !v.startsWith(valuePrefix)) continue;
        return v;
    }
    return undefined;
}

export function observeNativeIdentity(
    input: NativeIdInput,
    store: SessionStore | null,
    log: (level: string, msg: string) => void,
): void {
    try {
        const ex = extractNativeIdentity(input);
        if (ex === null) return;
        const recordKey = input.key ?? (ex.sessH !== undefined ? `n:${ex.sessH}` : "anon");
        if (recordKey.length === 0) return;

        const now = Date.now();
        let prev: NidvObs | null = null;
        // Same house pattern as fastpath's pf:state (#5403): ext namespaces only
        // exist on unified storage (shadow|full); legacy-only instances degrade
        // to log-line-only observation instead of throwing into the pipeline.
        const extUsable = store !== null && store.replicasAvailable();
        if (extUsable) {
            let raw: unknown;
            try {
                raw = store.getSessionExt(recordKey, NIDV_EXT_KEY);
            } catch {
                raw = undefined;
            }
            if (typeof raw === "string" && raw.length > 0) {
                try {
                    const p = JSON.parse(raw) as NidvObs;
                    if (p !== null && typeof p === "object" && p.v === 1) prev = p;
                } catch {
                    prev = null;
                }
            }
        }

        const events: NidvEvent[] = [];
        const next: NidvObs = {
            v: 1,
            client: ex.client,
            firstSeen: prev?.firstSeen ?? now,
            lastSeen: now,
            reqs: (prev?.reqs ?? 0) + 1,
            ids: {},
            events: [...(prev?.events ?? [])],
        };
        if (prev !== null && prev.client !== ex.client) {
            events.push({ t: now, k: "profile_flip", e: `${prev.client}->${ex.client}` });
        }

        if (ex.sessH !== undefined) {
            const ps = prev?.ids.sess;
            if (ps === undefined) next.ids.sess = { h: ex.sessH, stable: "unknown" };
            else if (ps.h === ex.sessH) next.ids.sess = { h: ps.h, stable: ps.stable === "no" ? "no" : "yes" };
            else {
                next.ids.sess = { h: ex.sessH, stable: "no" };
                events.push({ t: now, k: "id_change", e: "sess" });
            }
        } else {
            next.ids.sess = prev?.ids.sess;
        }

        const curDigests = (input.msgIds ?? []).map((m) => digest8(m));
        if (curDigests.length > 0) {
            const ringPrev = prev?.ids.msg?.ring ?? [];
            const repeat = curDigests.some((h) => ringPrev.includes(h));
            const merged = [...curDigests, ...ringPrev.filter((h) => !curDigests.includes(h))].slice(0, RING_CAP);
            const n = (prev?.ids.msg?.n ?? 0) + curDigests.length;
            // Per-turn verdict, deliberately not sticky: in the incremental lane consecutive
            // deltas do NOT overlap by design, so a resend is the only "yes" evidence.
            const stable: NidvMsgStats["stable"] = repeat ? "yes" : n >= 8 ? "no" : "unknown";
            next.ids.msg = { n, distinct: new Set(merged).size, stable, ring: merged };
        } else {
            next.ids.msg = prev?.ids.msg;
        }

        if (ex.prevRespH !== undefined) {
            if (prev?.ids.prevRespH !== undefined && prev.ids.prevRespH !== ex.prevRespH) {
                events.push({ t: now, k: "id_change", e: "prevresp" });
            }
            next.ids.prevRespH = ex.prevRespH;
        } else {
            next.ids.prevRespH = prev?.ids.prevRespH;
        }

        if (ex.prefix !== undefined && ex.prefix.role === "user") {
            events.push({ t: now, k: "compaction", e: `preface@elem${String(ex.prefix.elemIdx)}` });
        }
        if (ex.edge !== undefined) events.push({ t: now, k: "compaction", e: `hdr=${ex.edge}` });
        if (ex.dual === "mismatch") events.push({ t: now, k: "dual_mismatch", e: `${next.ids.sess?.h ?? "?"}` });
        for (const c of ex.counts) {
            if (c.assertZero === true && c.n > 0) events.push({ t: now, k: "shape_assert_fail", e: `${c.label}=${String(c.n)}` });
        }
        if (ex.fork === true) events.push({ t: now, k: "fork", e: "parent-sess" });

        for (const ev of events) {
            const last = next.events[next.events.length - 1];
            if (last !== undefined && last.k === ev.k && last.e === ev.e) {
                last.t = ev.t;
            } else {
                next.events.push(ev);
            }
        }
        if (next.events.length > EVENT_CAP) next.events.splice(0, next.events.length - EVENT_CAP);

        const line = renderLine(ex, events);
        log(events.some((e) => WARN_EVENTS.has(e.k)) ? "warn" : "debug", line);
        if (extUsable) {
            try {
                store.setSessionExt(recordKey, NIDV_EXT_KEY, fitBudget(next));
            } catch { /* observation is advisory — losing it degrades to log-line-only */ }
        }
    } catch {
        // fail-open: an observation defect must never disturb the request path.
    }
}

function renderLine(ex: NativeIdExtraction, fresh: NidvEvent[]): string {
    const evt = fresh.length > 0 ? fresh.map((e) => (e.e !== undefined ? `${e.k}(${e.e})` : e.k)).join(",") : "-";
    const note = ex.noteParts.length > 0 ? ` ${ex.noteParts.join(" ").slice(0, 160)}` : "";
    const sess = ex.sessH !== undefined ? `${ex.sessH}\u2026` : "-";
    return `nidv: client=${ex.client} sess=${sess} msgΔ=+${String(ex.delta)} evt=${evt}${note}`;
}

function fitBudget(obs: NidvObs): string {
    let json = JSON.stringify(obs);
    if (json.length <= EXT_BUDGET) return json;
    obs.events = obs.events.slice(-8);
    json = JSON.stringify(obs);
    if (json.length <= EXT_BUDGET) return json;
    if (obs.ids.msg !== undefined) obs.ids.msg.ring = obs.ids.msg.ring.slice(0, 16);
    json = JSON.stringify(obs);
    if (json.length <= EXT_BUDGET) return json;
    obs.events = obs.events.slice(-4);
    return JSON.stringify(obs);
}
