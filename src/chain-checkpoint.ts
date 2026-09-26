import { createHash } from "node:crypto";
import type { WireProtocol } from "./util.js";

// #1357/#1395/#1421 — Chain Checkpoint (first-processor-wins idempotent interop).
// A request-level checkpoint marks a request that already passed through a
// bili pipeline; downstream bili instances recognize it and forward silently
// instead of re-running kernel/injection. This module is STEP 2+3: recognition
// (parser, per-wire carrier contract, JCS digest, verdicts) plus generation +
// enforcement (stampOutbound; server.ts maps verdicts to forward-or-process).
//
// IDENTIFICATION-CONTRACT FREEZE (#1397 step 2): the parser, the JCS digest
// scheme, and the verdict matrix are frozen — they define what every future
// bili trusts. Step 3 (#1421) changed only WHERE the carrier sits (the
// stamp/strip shapes below), never WHAT a checkpoint is.
//
// Carrier contract (#1395 decision (a), ownership-based): a checkpoint lives
// ONLY in a bili-owned trailing control slot — the trailing run of user-role
// entries after the last non-user entry. Content the model or user can
// generate themselves elsewhere is never a carrier; there is deliberately no
// global magic-string scanning anywhere else in the body. Matching is always
// whole-PART (not substring): a slot/part containing anything besides the tag
// is not a carrier. If a client's own final message literally is a well-formed
// tag binding its own digest, open mode treats that as an explicit
// self-opt-out — accepted by design.
//
// Stamp shape per wire (#1421 owner decision, 2026-09-26 — role-alternation-
// strict wires must NOT append a second user entry):
//   anthropic   merge as an EXTRA TRAILING TEXT PART of the last user message
//               (string content normalizes to parts); standalone append only
//               when the body does not end in a user message. Native Anthropic
//               tolerates same-side runs, but gateways/intermediaries are not
//               all that lenient — never emit them.
//   google      merge into the LAST CONTENT'S PARTS (mandatory, mirrors
//               appendGoogleNudge): bili's own pipeline enforces alternation
//               (coreToGoogle fuses same-side runs), so the append form died
//               inside our own proxy before any upstream saw it.
//   openai      standalone trailing user MESSAGE (append).
//   responses   standalone trailing user message, inserted BEFORE any trailing
//               compaction_trigger (#283/#209 invariant).
// Recognition matches the shape each wire emits: openai/responses keep the
// whole-content rule; anthropic accepts a LAST part that entirely is the tag;
// google accepts ANY part that entirely is the tag (a later hop's nudge merge
// can push the tag off the end of the parts array).
//
// Verdict semantics (enforced in server.ts, #1421):
//   valid            ≥1 known-version candidate whose digest matches and is fresh
//                    → first-processor-wins: forward verbatim, pipeline skipped
//   recent-mismatch  no digest match, but a well-formed FRESH checkpoint (a
//                    different bili processed this body) → forward verbatim + warn
//   stale            digest match with out-of-window/future timestamp (replay or
//                    clock skew → forward verbatim + warn), OR no-match stale-only
//                    (→ strip the stale carrier(s) and process normally)
//   invalid          malformed-looking tag(s) in carrier slots, future-dated
//                    beyond skew only, or unknown version only → never trusted,
//                    process normally
//   none             no checkpoint signal at all
export const CHAIN_TAG = "bili-chain";
export const SUPPORTED_CHECKPOINT_VERSION = 1;
export const DEFAULT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
export const DEFAULT_RECENT_CHECKPOINT_WINDOW_MS = 10 * 60 * 1000;
// Generous parser ceiling: the generator emits ≤~200 chars (design target
// ≤~120 with short ids); the cap only bounds malformed-tag scanning cost.
const MAX_CHECKPOINT_CHARS = 512;

const TAG_OPEN = "\x3cbili-chain ";
const TAG_CLOSE = "/\x3e";

export interface ChainCheckpoint {
    v: number;
    processor: string;
    issuedAt: number;
    requestId: string;
    digest: string;
}

export type ChainVerdict = "none" | "valid" | "recent-mismatch" | "stale" | "invalid";

export interface ChainCheckpointContext {
    candidates: ChainCheckpoint[];
    malformed: number;
    selected?: ChainCheckpoint;
    /** True when `selected` came from a DIGEST-MATCHED candidate — the stale
     *  verdict splits on this: matched → forward verbatim (replay/skew),
     *  unmatched → strip + process (#1421). Undefined for invalid/none. */
    selectedMatched?: boolean;
    verdict: ChainVerdict;
}

const ATTRS = ["v", "processor", "issued-at", "request-id", "digest"] as const;
type AttrName = (typeof ATTRS)[number];

function validAttrValue(name: AttrName, raw: string): boolean {
    switch (name) {
        case "v":
            return /^\d+$/.test(raw) && Number(raw) >= 1;
        case "issued-at":
            return /^\d{1,16}$/.test(raw);
        case "processor":
            return /^[A-Za-z0-9._-]{1,64}$/.test(raw);
        case "request-id":
            return /^[A-Za-z0-9._:-]{1,64}$/.test(raw);
        case "digest":
            return /^sha256:[0-9a-f]{64}$/.test(raw);
    }
}

export function parseChainCheckpoint(text: unknown): ChainCheckpoint | null {
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_CHECKPOINT_CHARS) return null;
    if (!text.startsWith(TAG_OPEN) || !text.endsWith(TAG_CLOSE)) return null;
    const inner = text.slice(TAG_OPEN.length, -TAG_CLOSE.length);
    const found: Partial<Record<AttrName, string>> = {};
    for (const token of inner.split(/\s+/)) {
        const m = /^([a-z][a-z0-9-]*)="([^"]*)"$/.exec(token);
        if (!m) return null;
        const name = m[1] as string;
        if (!(ATTRS as readonly string[]).includes(name)) return null;
        if (Object.hasOwn(found, name)) return null;
        found[name as AttrName] = m[2];
    }
    for (const attr of ATTRS) {
        const raw = found[attr];
        if (raw === undefined || !validAttrValue(attr, raw)) return null;
    }
    return {
        v: Number(found.v),
        processor: found.processor as string,
        issuedAt: Number(found["issued-at"]),
        requestId: found["request-id"] as string,
        digest: found.digest as string,
    };
}

export function renderChainCheckpoint(cp: ChainCheckpoint): string {
    return `${TAG_OPEN}v="${cp.v}" processor="${cp.processor}" issued-at="${cp.issuedAt}" request-id="${cp.requestId}" digest="${cp.digest}"${TAG_CLOSE}`;
}

interface CarrierHit {
    messageIndex: number;
    /** undefined = whole-content carrier (the step-2 contract); N = index of
     *  the carrier part inside the entry's content/parts array (#1421 merge
     *  shapes). */
    partIndex?: number;
    text: string;
}

/** Trailing run of user-role messages after the last non-user entry (the
 *  anthropic/openai carrier slots), oldest first. `relaxLastPart` (anthropic,
 *  #1421) also admits a multi-part content whose LAST part entirely is a tag —
 *  the shape insertCheckpointCarrier emits when merging into a user-final body. */
function trailingUserHitsAnthropicLike(body: Record<string, unknown>, relaxLastPart: boolean): CarrierHit[] {
    const messages = body.messages;
    if (!Array.isArray(messages)) return [];
    const out: CarrierHit[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) break;
        const m = msg as Record<string, unknown>;
        if (m.role !== "user") break;
        const whole = singleText(m.content, "text");
        if (whole !== undefined) {
            out.push({ messageIndex: i, text: whole });
            continue;
        }
        if (relaxLastPart && Array.isArray(m.content)) {
            const li = m.content.length - 1;
            const lp = m.content[li];
            if (lp && typeof lp === "object" && !Array.isArray(lp)) {
                const lpo = lp as Record<string, unknown>;
                if (lpo.type === "text" && typeof lpo.text === "string" && Object.keys(lpo).length === 2) {
                    out.push({ messageIndex: i, partIndex: li, text: lpo.text as string });
                }
            }
        }
    }
    return out.reverse();
}

/** Same trailing-run rule on Responses `input` items (type=message role=user). */
function trailingUserHitsResponses(body: Record<string, unknown>): CarrierHit[] {
    const input = body.input;
    if (typeof input === "string") return input === "" ? [] : [{ messageIndex: -1, text: input }];
    if (!Array.isArray(input)) return [];
    // A trailing compaction_trigger is transparent to the carrier slot: the
    // stamp inserts BEFORE it (#283 keeps it last), so recognition looks past it.
    let end = input.length - 1;
    const last = input[end];
    if (last && typeof last === "object" && !Array.isArray(last) && (last as Record<string, unknown>).type === "compaction_trigger") end -= 1;
    const out: CarrierHit[] = [];
    for (let i = end; i >= 0; i--) {
        const item = input[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) break;
        const it = item as Record<string, unknown>;
        if (it.type !== "message" || it.role !== "user") break;
        if (singleText(it.content, "input_text") === undefined) break;
        out.push({ messageIndex: i, text: singleText(it.content, "input_text")! });
    }
    return out.reverse();
}

/** Google trailing-user content, ANY part admitted (#1421): a later hop's nudge
 *  merge can push the tag off the end of parts, so position within the array
 *  is not part of the contract — only "part entirely is the tag". */
function trailingUserHitsGoogle(body: Record<string, unknown>): CarrierHit[] {
    const contents = body.contents;
    if (!Array.isArray(contents)) return [];
    const out: CarrierHit[] = [];
    for (let i = contents.length - 1; i >= 0; i--) {
        const c = contents[i];
        if (!c || typeof c !== "object" || Array.isArray(c)) break;
        const ct = c as Record<string, unknown>;
        if (ct.role !== "user" || !Array.isArray(ct.parts)) break;
        for (let j = 0; j < ct.parts.length; j++) {
            const p = ct.parts[j];
            if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 1 && typeof (p as Record<string, unknown>).text === "string") {
                out.push({ messageIndex: i, partIndex: j, text: (p as Record<string, unknown>).text as string });
            }
        }
    }
    return out.reverse();
}

export interface ChainExtraction {
    candidates: ChainCheckpoint[];
    malformed: number;
    /** The body with every recognized carrier removed — whole-slot for
     *  standalone carriers, surgical part-removal for merged ones (an emptied
     *  entry is dropped). */
    stripped: unknown;
}

/** Per-wire carrier recognition (#1395 decision (a), shapes per #1421).
 *  Returns candidates + the carrier-stripped body. */
export function extractChainCarriers(parsed: unknown, wire: WireProtocol): ChainExtraction {
    const result: ChainExtraction = { candidates: [], malformed: 0, stripped: parsed };
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    const body = parsed as Record<string, unknown>;
    let hits: CarrierHit[] = [];
    switch (wire) {
        case "anthropic":
            hits = trailingUserHitsAnthropicLike(body, true);
            break;
        case "openai":
            hits = trailingUserHitsAnthropicLike(body, false);
            break;
        case "responses":
            hits = trailingUserHitsResponses(body);
            break;
        case "google":
            hits = trailingUserHitsGoogle(body);
            break;
    }
    const dropParts = new Map<number, Set<number>>();
    for (const hit of hits) {
        if (!hit.text.startsWith("\x3c" + CHAIN_TAG)) continue;
        const cp = parseChainCheckpoint(hit.text);
        if (cp) {
            result.candidates.push(cp);
            const parts = dropParts.get(hit.messageIndex) ?? new Set<number>();
            if (hit.partIndex !== undefined) parts.add(hit.partIndex);
            dropParts.set(hit.messageIndex, parts);
        } else {
            result.malformed += 1;
        }
    }
    if (dropParts.size > 0) {
        if (wire === "responses" && typeof body.input === "string") {
            result.stripped = { ...body, input: "" };
        } else {
            const key = wire === "google" ? "contents" : wire === "responses" ? "input" : "messages";
            const arr = body[key];
            if (Array.isArray(arr)) {
                const next: unknown[] = [];
                for (let i = 0; i < arr.length; i++) {
                    const entry = arr[i];
                    const parts = dropParts.get(i);
                    if (parts === undefined) { next.push(entry); continue; }
                    if (parts.size > 0 && entry && typeof entry === "object" && !Array.isArray(entry)) {
                        const e = entry as Record<string, unknown>;
                        const partKey = wire === "google" ? "parts" : "content";
                        const partsArr = e[partKey];
                        if (Array.isArray(partsArr)) {
                            const kept = partsArr.filter((_, j) => !parts.has(j));
                            if (kept.length > 0) { next.push({ ...e, [partKey]: kept }); continue; }
                        }
                    }
                }
                result.stripped = { ...body, [key]: next };
            }
        }
    }
    return result;
}

function singleText(content: unknown, partType: string): string | undefined {
    if (typeof content === "string") return content;
    if (Array.isArray(content) && content.length === 1) {
        const only = content[0];
        if (only && typeof only === "object" && !Array.isArray(only)) {
            const part = only as Record<string, unknown>;
            if (part.type === partType && typeof part.text === "string" && Object.keys(part).length === 2) {
                return part.text;
            }
        }
    }
    return undefined;
}

// RFC 8785 (JCS) canonicalization, dependency-free: recursive key sort by
// Unicode code point (NOT UTF-16 unit order — astral keys differ), arrays in
// order, JSON.stringify escaping (JCS-compatible: short control forms, lower
// \uXXXX hex), JS shortest-round-trip numbers per §3.2.2 (with the -0 fix).
function jcsKeyCompare(a: string, b: string): number {
    // Numeric code-point comparison: string `<` compares UTF-16 units, which
    // diverges from code-point order at the surrogate boundary (U+D800–U+DFFF
    // vs U+10000+). RFC 8785 §2.3 requires code points.
    const ca = [...a].map((ch) => ch.codePointAt(0)!);
    const cb = [...b].map((ch) => ch.codePointAt(0)!);
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
        const x = ca[i]!;
        const y = cb[i]!;
        if (x !== y) return x - y;
    }
    return ca.length - cb.length;
}

export function jcsStringify(value: unknown): string {
    if (value === null || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(jcsStringify).join(",") + "]";
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort(jcsKeyCompare);
        return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcsStringify(obj[k])).join(",") + "}";
    }
    return "null";
}

export function computeRequestDigest(parsed: unknown, wire: WireProtocol): string {
    const { stripped } = extractChainCarriers(parsed, wire);
    return sha256Of(jcsStringify(stripped));
}

function sha256Of(canonical: string): string {
    return "sha256:" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

const ZERO_DIGEST = "sha256:" + "0".repeat(64);

/** Insert a checkpoint carrier for `wire` into a parsed body (#1421 shapes —
 *  see module header). Restamping an already-stamped body REPLACES the
 *  trailing carrier instead of stacking. Returns the new body or null when
 *  the shape admits no carrier slot. */
export function insertCheckpointCarrier(parsed: unknown, wire: WireProtocol, tag: string): unknown | null {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    if (wire === "openai") {
        const messages = body.messages;
        if (!Array.isArray(messages)) return null;
        const li = messages.length - 1;
        const last = messages[li];
        if (last && typeof last === "object" && !Array.isArray(last) && (last as Record<string, unknown>).role === "user") {
            const whole = singleText((last as Record<string, unknown>).content, "text");
            if (whole !== undefined && parseChainCheckpoint(whole)) {
                return { ...body, messages: [...messages.slice(0, li), { role: "user", content: tag }] };
            }
        }
        return { ...body, messages: [...messages, { role: "user", content: tag }] };
    }
    if (wire === "anthropic") {
        const messages = body.messages;
        if (!Array.isArray(messages)) return null;
        const li = messages.length - 1;
        const last = messages[li];
        if (last && typeof last === "object" && !Array.isArray(last) && (last as Record<string, unknown>).role === "user") {
            const m = last as Record<string, unknown>;
            const content = m.content;
            if (typeof content === "string" || Array.isArray(content)) {
                const merged: unknown[] = typeof content === "string"
                    ? (content === "" ? [] : [{ type: "text", text: content }])
                    : [...content];
                const pi = merged.length - 1;
                const pp = merged[pi];
                if (pp && typeof pp === "object" && !Array.isArray(pp)) {
                    const ppo = pp as Record<string, unknown>;
                    if (ppo.type === "text" && typeof ppo.text === "string" && Object.keys(ppo).length === 2 && parseChainCheckpoint(ppo.text)) {
                        merged.splice(pi, 1);
                    }
                }
                merged.push({ type: "text", text: tag });
                return { ...body, messages: [...messages.slice(0, li), { ...m, content: merged }] };
            }
        }
        return { ...body, messages: [...messages, { role: "user", content: tag }] };
    }
    if (wire === "responses") {
        const input = body.input;
        if (typeof input === "string") {
            // Two-part messages are not carrier slots (singleText needs exactly
            // one part) — normalize to array form or the stamp is never recognized.
            const orig = input === "" ? [] : [{ type: "message", role: "user", content: input }];
            return { ...body, input: [...orig, { type: "message", role: "user", content: tag }] };
        }
        if (!Array.isArray(input)) return null;
        let insertAt = input.length;
        const last = input[insertAt - 1];
        if (last && typeof last === "object" && !Array.isArray(last) && (last as Record<string, unknown>).type === "compaction_trigger") insertAt -= 1;
        const before = input[insertAt - 1];
        if (before && typeof before === "object" && !Array.isArray(before)) {
            const b = before as Record<string, unknown>;
            const whole = singleText(b.content, "input_text");
            if (b.type === "message" && b.role === "user" && whole !== undefined && parseChainCheckpoint(whole)) {
                return { ...body, input: [...input.slice(0, insertAt - 1), { type: "message", role: "user", content: tag }, ...input.slice(insertAt)] };
            }
        }
        const next = [...input.slice(0, insertAt), { type: "message", role: "user", content: tag }, ...input.slice(insertAt)];
        return { ...body, input: next };
    }
    const contents = body.contents;
    if (!Array.isArray(contents)) return null;
    const li = contents.length - 1;
    const last = contents[li];
    if (last && typeof last === "object" && !Array.isArray(last)) {
        const c = last as Record<string, unknown>;
        const role = typeof c.role === "string" ? c.role : "user";
        if (role !== "model") {
            const parts = Array.isArray(c.parts) ? (c.parts as unknown[]) : [];
            const pi = parts.length - 1;
            const pp = parts[pi];
            if (pp && typeof pp === "object" && !Array.isArray(pp)) {
                const ppo = pp as Record<string, unknown>;
                if (Object.keys(ppo).length === 1 && typeof ppo.text === "string" && parseChainCheckpoint(ppo.text)) {
                    return { ...body, contents: [...contents.slice(0, li), { ...c, parts: [...parts.slice(0, pi), { text: tag }] }] };
                }
            }
            return { ...body, contents: [...contents.slice(0, li), { ...c, parts: [...parts, { text: tag }] }] };
        }
    }
    return { ...body, contents: [...contents, { role: "user", parts: [{ text: tag }] }] };
}

/** Step-3 generation (#1421): stamp a parsed outbound body with a fresh
 *  request-level checkpoint for this instance. The digest covers the stamped
 *  body minus its own carrier (computeCheckpointDigest round-trip property),
 *  so any downstream bili verifying the same bytes recomputes the same value.
 *  requestId derives from the digest — deterministic, constant-size, and it
 *  correlates the stamp with the exact body it covers. */
export function stampOutbound(parsed: unknown, wire: WireProtocol, processor: string, nowMs: number = Date.now()): unknown | null {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const placeholder: Pick<ChainCheckpoint, "v" | "processor" | "issuedAt" | "requestId"> = { v: SUPPORTED_CHECKPOINT_VERSION, processor, issuedAt: nowMs, requestId: "-" };
    const digest = computeCheckpointDigest(parsed, wire, placeholder);
    if (digest === null) return null;
    const requestId = digest.slice("sha256:".length, "sha256:".length + 8);
    const tag = renderChainCheckpoint({ v: SUPPORTED_CHECKPOINT_VERSION, processor, issuedAt: nowMs, requestId, digest });
    return insertCheckpointCarrier(parsed, wire, tag);
}

// Generation-side digest (step 3 stamps with this): insert a zero-digest
// carrier, strip carriers, canonicalize + hash — so the rendered tag carries
// a digest that validates against the STAMPED body (round-trip property).
export function computeCheckpointDigest(parsed: unknown, wire: WireProtocol, fields: Pick<ChainCheckpoint, "v" | "processor" | "issuedAt" | "requestId">): string | null {
    const stamped = insertCheckpointCarrier(parsed, wire, renderChainCheckpoint({ ...fields, digest: ZERO_DIGEST }));
    if (stamped === null) return null;
    const { stripped } = extractChainCarriers(stamped, wire);
    return sha256Of(jcsStringify(stripped));
}

export interface ChainEvaluationOptions {
    nowMs?: number;
    maxFutureSkewMs?: number;
    recentWindowMs?: number;
}

function envMs(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function evaluateChain(parsed: unknown, wire: WireProtocol, opts: ChainEvaluationOptions = {}): ChainCheckpointContext {
    const nowMs = opts.nowMs ?? Date.now();
    const maxFutureSkewMs = opts.maxFutureSkewMs ?? envMs("BILI_CHAIN_MAX_FUTURE_SKEW_MS", DEFAULT_MAX_FUTURE_SKEW_MS);
    const recentWindowMs = opts.recentWindowMs ?? envMs("BILI_CHAIN_RECENT_WINDOW_MS", DEFAULT_RECENT_CHECKPOINT_WINDOW_MS);
    const { candidates, malformed, stripped } = extractChainCarriers(parsed, wire);
    if (candidates.length === 0) {
        return { candidates, malformed, verdict: malformed > 0 ? "invalid" : "none" };
    }
    const digest = sha256Of(jcsStringify(stripped));
    type TimeClass = "fresh" | "stale" | "future";
    interface Classified {
        cp: ChainCheckpoint;
        match: boolean;
        time: TimeClass;
        knownVersion: boolean;
    }
    const classified: Classified[] = candidates.map((cp) => {
        const time: TimeClass = cp.issuedAt - nowMs > maxFutureSkewMs ? "future" : nowMs - cp.issuedAt > recentWindowMs ? "stale" : "fresh";
        return { cp, match: cp.digest === digest, time, knownVersion: cp.v === SUPPORTED_CHECKPOINT_VERSION };
    });
    const usable = classified.filter((c) => c.knownVersion);
    const pickLatest = (arr: Classified[]): Classified | undefined =>
        arr.reduce<Classified | undefined>((best, c) => (!best || c.cp.issuedAt > best.cp.issuedAt ? c : best), undefined);
    // Classify first, then take latest: a digest MATCH proves identity and
    // outranks any fresher mismatched candidate (never trust a newer forged
    // timestamp over a verified digest).
    const matchedFresh = pickLatest(usable.filter((c) => c.match && c.time === "fresh"));
    if (matchedFresh) return { candidates, malformed, selected: matchedFresh.cp, selectedMatched: true, verdict: "valid" };
    const matchedOther = pickLatest(usable.filter((c) => c.match));
    if (matchedOther) return { candidates, malformed, selected: matchedOther.cp, selectedMatched: true, verdict: "stale" };
    const nomatchFresh = pickLatest(usable.filter((c) => !c.match && c.time === "fresh"));
    if (nomatchFresh) return { candidates, malformed, selected: nomatchFresh.cp, selectedMatched: false, verdict: "recent-mismatch" };
    const nomatchStale = pickLatest(usable.filter((c) => !c.match && c.time === "stale"));
    if (nomatchStale) return { candidates, malformed, selected: nomatchStale.cp, selectedMatched: false, verdict: "stale" };
    return { candidates, malformed, verdict: "invalid" };
}
