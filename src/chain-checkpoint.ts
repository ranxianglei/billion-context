import { createHash } from "node:crypto";
import type { WireProtocol } from "./util.js";

// #1357/#1395 — Chain Checkpoint (first-processor-wins idempotent interop).
// A request-level checkpoint marks a request that already passed through a
// bili pipeline; downstream bili instances recognize it and forward silently
// instead of re-running kernel/injection. This module is STEP 2: recognition
// only — parser, per-wire carrier contract, JCS digest, shadow verdicts.
// Generation + enforcement land in step 3 (separate human-reviewed PR).
//
// Carrier contract (#1395 decision (a), ownership-based): a checkpoint lives
// ONLY in a bili-owned trailing control slot — the trailing run of user-role
// messages after the last non-user entry, whose ENTIRE content strictly
// equals the tag syntax below. Content the model or user can generate
// themselves is never a carrier; there is deliberately no global
// magic-string scanning anywhere else in the body. The strict full-content
// match (not the role) is what makes a slot eligible: if a client's own
// final message literally is a well-formed tag binding its own digest, open
// mode treats that as an explicit self-opt-out — accepted by design.
//
// Verdict semantics (shadow mode logs only; step 3 maps them to behavior):
//   valid            ≥1 known-version candidate whose digest matches and is fresh
//   recent-mismatch  no digest match, but a well-formed FRESH checkpoint (a
//                    different bili processed this body) → step 3 forwards + warns
//   stale            digest match with out-of-window/future timestamp (replay or
//                    clock skew → step 3 forwards + warns), OR no-match stale-only
//                    (→ step 3 strips and processes normally)
//   invalid          malformed-looking tag(s) in carrier slots, future-dated
//                    beyond skew only, or unknown version only → never trusted
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

interface CarrierSlot {
    messageIndex: number;
    text: string;
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

function trailingUserSlotsAnthropicLike(body: Record<string, unknown>): CarrierSlot[] {
    const messages = body.messages;
    if (!Array.isArray(messages)) return [];
    const slots: CarrierSlot[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) break;
        const m = msg as Record<string, unknown>;
        if (m.role !== "user") break;
        const text = singleText(m.content, "text");
        if (text !== undefined) slots.push({ messageIndex: i, text });
    }
    return slots.reverse();
}

function trailingUserSlotsResponses(body: Record<string, unknown>): CarrierSlot[] {
    const input = body.input;
    if (typeof input === "string") return input === "" ? [] : [{ messageIndex: -1, text: input }];
    if (!Array.isArray(input)) return [];
    let end = input.length - 1;
    const last = input[end];
    if (last && typeof last === "object" && !Array.isArray(last) && (last as Record<string, unknown>).type === "compaction_trigger") {
        end -= 1;
    }
    const slots: CarrierSlot[] = [];
    for (let i = end; i >= 0; i--) {
        const item = input[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) break;
        const it = item as Record<string, unknown>;
        if (it.type !== "message" || it.role !== "user") break;
        const text = singleText(it.content, "input_text");
        if (text !== undefined) slots.push({ messageIndex: i, text });
    }
    return slots.reverse();
}

function trailingUserSlotsGoogle(body: Record<string, unknown>): CarrierSlot[] {
    const contents = body.contents;
    if (!Array.isArray(contents)) return [];
    const slots: CarrierSlot[] = [];
    for (let i = contents.length - 1; i >= 0; i--) {
        const c = contents[i];
        if (!c || typeof c !== "object" || Array.isArray(c)) break;
        const ct = c as Record<string, unknown>;
        if (ct.role !== "user") break;
        const parts = ct.parts;
        if (Array.isArray(parts) && parts.length === 1) {
            const p = parts[0];
            if (p && typeof p === "object" && !Array.isArray(p) && typeof (p as Record<string, unknown>).text === "string" && Object.keys(p).length === 1) {
                slots.push({ messageIndex: i, text: (p as Record<string, unknown>).text as string });
            }
        }
    }
    return slots.reverse();
}

export interface ChainExtraction {
    candidates: ChainCheckpoint[];
    malformed: number;
    stripped: unknown;
}

export function extractChainCarriers(parsed: unknown, wire: WireProtocol): ChainExtraction {
    const result: ChainExtraction = { candidates: [], malformed: 0, stripped: parsed };
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    const body = parsed as Record<string, unknown>;
    let slots: CarrierSlot[] = [];
    switch (wire) {
        case "anthropic":
        case "openai":
            slots = trailingUserSlotsAnthropicLike(body);
            break;
        case "responses":
            slots = trailingUserSlotsResponses(body);
            break;
        case "google":
            slots = trailingUserSlotsGoogle(body);
            break;
    }
    const hitIndexes = new Set<number>();
    for (const slot of slots) {
        if (!slot.text.startsWith("\x3c" + CHAIN_TAG)) continue;
        const cp = parseChainCheckpoint(slot.text);
        if (cp) {
            result.candidates.push(cp);
            hitIndexes.add(slot.messageIndex);
        } else {
            result.malformed += 1;
        }
    }
    if (hitIndexes.size > 0) {
        const strip = (arr: unknown[]): unknown[] => arr.filter((_, i) => !hitIndexes.has(i));
        if (wire === "responses" && typeof body.input === "string") {
            result.stripped = { ...body, input: "" };
        } else {
            const key = wire === "google" ? "contents" : wire === "responses" ? "input" : "messages";
            const arr = body[key];
            if (Array.isArray(arr)) result.stripped = { ...body, [key]: strip(arr) };
        }
    }
    return result;
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

export function insertCheckpointCarrier(parsed: unknown, wire: WireProtocol, tag: string): unknown | null {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    if (wire === "anthropic" || wire === "openai") {
        const messages = body.messages;
        if (!Array.isArray(messages)) return null;
        return { ...body, messages: [...messages, { role: "user", content: tag }] };
    }
    if (wire === "responses") {
        const input = body.input;
        if (typeof input === "string") return { ...body, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input }, { type: "input_text", text: tag }] }] };
        if (!Array.isArray(input)) return null;
        let insertAt = input.length;
        const last = input[insertAt - 1];
        if (last && typeof last === "object" && !Array.isArray(last) && (last as Record<string, unknown>).type === "compaction_trigger") insertAt -= 1;
        const next = [...input.slice(0, insertAt), { type: "message", role: "user", content: tag }, ...input.slice(insertAt)];
        return { ...body, input: next };
    }
    const contents = body.contents;
    if (!Array.isArray(contents)) return null;
    return { ...body, contents: [...contents, { role: "user", parts: [{ text: tag }] }] };
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
    if (matchedFresh) return { candidates, malformed, selected: matchedFresh.cp, verdict: "valid" };
    const matchedOther = pickLatest(usable.filter((c) => c.match));
    if (matchedOther) return { candidates, malformed, selected: matchedOther.cp, verdict: "stale" };
    const nomatchFresh = pickLatest(usable.filter((c) => !c.match && c.time === "fresh"));
    if (nomatchFresh) return { candidates, malformed, selected: nomatchFresh.cp, verdict: "recent-mismatch" };
    const nomatchStale = pickLatest(usable.filter((c) => !c.match && c.time === "stale"));
    if (nomatchStale) return { candidates, malformed, selected: nomatchStale.cp, verdict: "stale" };
    return { candidates, malformed, verdict: "invalid" };
}
