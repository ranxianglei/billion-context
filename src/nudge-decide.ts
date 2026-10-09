// #2228: model-decided nudge timing (route A — side-channel decision call).
// When the statistical gate arms a tier-1 nudge, the proxy asks the model one
// short question over the session's ALREADY-CACHED prefix (same system/tools/
// messages, no nudge tail, tiny output budget) instead of injecting advisory
// text blindly. This module holds the pure logic: question/directive wording,
// strict answer parsing, live-range validation, the failure ladder, and
// per-protocol answer extraction. The wire call itself lives in server.ts
// (runNudgeDecision) so it can reuse the main request's forward target —
// cache-mark parity with the stable prefix is what keeps the call cheap.
//
// Failure semantics (owner-approved ladder): a hard failure (timeout / HTTP
// error / unparseable answer) vetoes THIS round only ("never force-compress
// on garbage data") but counts toward session.metadata.nudgeDecideFails; after
// DECIDE_FALLBACK_THRESHOLD consecutive failures the NEXT arm skips the
// decision entirely and injects the legacy advisory nudge once, then resets —
// self-healing if the provider or model recovers. A parsed "no" is the model
// exercising its veto: it resets the counter and never falls back (only the
// EMERGENCY arm bypasses the decision outright and stays the last-line
// backstop against compression starvation — over-limit tier-1 arms DO route
// through the decision, by design).

import type { CompressibleRange } from "acp-kernel";
import { unwrapDataEnvelope } from "./preflight.js";

/** Output budget for the decision call. Matches the SIDE_REQUEST_MAX_TOKENS=200
 *  system (title-gen side requests use the same ceiling class). */
export const DEFAULT_DECIDE_MAX_TOKENS = 200;
/** Idle timeout for the decision call. Cache-hit input + ~50 output tokens
 *  normally lands in 1–3 s; 15 s bounds the worst case before we veto. */
export const DECIDE_TIMEOUT_MS = 15_000;
/** Consecutive hard failures before the next arm falls back to the advisory
 *  nudge once and resets the counter. */
export const DECIDE_FALLBACK_THRESHOLD = 3;

const LADDER_KEY = "nudgeDecideFails";
const RANGE_RE = /^m(\d{4,})-m(\d{4,})$/;
const SPANS_SHOWN = 8;
const TOPIC_MAX_CHARS = 80;

/** Presence = enabled. Resolved by runPrepare from the three-level compress
 *  cascade (global → provider → model); undefined means the feature is off
 *  and the prepare* paths take the byte-identical legacy branch. */
export interface DecideConfig {
    maxTokens: number;
}

export type DecisionOutcome =
    | { kind: "yes"; range?: string; topic?: string }
    | { kind: "no" }
    | { kind: "failed"; detail: string };

function formatK(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return `${n}`;
}

/** The neutral question appended as the trailing user message of the decision
 *  call. Host-owned wording (the kernel owns the ADVISORY nudge text; this is
 *  a different artifact). Deliberately non-imperative: the whole point of the
 *  feature is that the model gets a real veto instead of an instruction with
 *  a checklist attached. */
export function buildDecisionPrompt(ranges: CompressibleRange[]): string {
    const spans = ranges.slice(0, SPANS_SHOWN).map(
        (r) => `  ${r.startRef}\u2013${r.endRef}  ${r.count} msgs  ${formatK(r.tokens)} [tool ${r.toolPct}% | text ${r.textPct}%]`,
    );
    return [
        "[bili-compress-decision] Side-channel question \u2014 answer ONLY this. Do not continue your task, do not call any tools.",
        "Given the conversation above exactly as it stands now, is compressing older consumed context NOW net-beneficial for the current task?",
        "Reply with ONLY one line of JSON, nothing else:",
        '{"compress": false}',
        'or {"compress": true, "range": "mNNNNN-mNNNNN", "topic": "<short topic>"}',
        "Rules: compress=true only if the task has clearly moved past the targeted content AND reclaiming it is worth more than keeping it verbatim. Prefer a span from the list below when one fits; otherwise cite any older span you can see in the ACP tags above. Do NOT perform the compression now \u2014 only answer.",
        ...(spans.length > 0
            ? [`Compressible spans (oldest first):`, ...spans]
            : ["No pre-detected compressible spans \u2014 judge from the ACP tags above."]),
    ].join("\n");
}

/** The directive injected into the MAIN request when the model says yes.
 *  Replaces the advisory text at the same injection point, so it passes
 *  through the same wrapper chain (marker-integrity / budget / staged
 *  guidance notes) at every site. Explicit span + topic: the program
 *  finalizes the range, the model never hand-picks endpoints at execution
 *  time (owner design: "\u76f4\u63a5\u7ed9\u51fa\u660e\u786e\u7684\u5982\u4f55\u538b\u7f29\u7684\u6307\u5bfc"). */
export function buildDirectiveText(startRef: string, endRef: string, topic?: string): string {
    return [
        "[bili-compress-directive] Compress NOW \u2014 this is a directive issued from your own decision above, not a suggestion.",
        `Target span: ${startRef}\u2013${endRef}${topic ? ` (topic: "${topic}")` : ""}. Call your compress tool on exactly this span in this turn and write the summary per the compression rules. Do not widen or narrow the span unless it contains protected content \u2014 then trim to the unprotected part.`,
    ].join("\n");
}

/** Strict parse of the model's answer. The ENTIRE trimmed response must be a
 *  single JSON object (an optional ```json fence is tolerated); prose around
 *  the JSON fails \u2014 a half-formed answer must look like garbage, because
 *  acting on it would force a compression the model never cleanly agreed to.
 *  Structural failures are "failed" (count toward the ladder): an ABSENT
 *  range degrades to "yes" without a range (the program then picks the
 *  largest live span), but a MALFORMED range fails outright — never act on a
 *  span the model did not cleanly express. */
export function parseDecision(raw: string): DecisionOutcome {
    let s = raw.trim();
    if (!s) return { kind: "failed", detail: "empty response" };
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
    if (fence) s = fence[1].trim();
    if (!s.startsWith("{") || !s.endsWith("}")) return { kind: "failed", detail: "not a bare JSON object" };
    let obj: unknown;
    try {
        obj = JSON.parse(s);
    } catch (e) {
        return { kind: "failed", detail: `invalid JSON (${String(e)})` };
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { kind: "failed", detail: "not an object" };
    const o = obj as Record<string, unknown>;
    if (typeof o.compress !== "boolean") return { kind: "failed", detail: "compress must be boolean" };
    if (!o.compress) return { kind: "no" };
    let range: string | undefined;
    if (o.range !== undefined) {
        if (typeof o.range === "string" && RANGE_RE.test(o.range)) range = o.range;
        else return { kind: "failed", detail: "malformed range" };
    }
    let topic: string | undefined;
    if (o.topic !== undefined) {
        if (typeof o.topic !== "string") return { kind: "failed", detail: "topic must be a string" };
        topic = o.topic.trim().slice(0, TOPIC_MAX_CHARS) || undefined;
    }
    return { kind: "yes", range, topic };
}

function refNum(ref: string): number {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
}

/** Finalize the executable span from the model's answer against the LIVE
 *  compressible view (turn.nudge.compressibleRanges, already filtered by
 *  viableRanges at the call site). A proposed span is honored only when it is
 *  fully contained in one live range; the returned span is that live range's
 *  endpoints (the program finalizes boundaries \u2014 sub-span granularity is
 *  out of scope for v1). No proposal, an out-of-view proposal, or an empty
 *  live view falls back to the LARGEST live range by tokens; no live range at
 *  all yields undefined (the caller skips injection \u2014 never invent a
 *  target). */
export function resolveDecisionRange(
    decision: { range?: string },
    ranges: CompressibleRange[],
): { startRef: string; endRef: string } | undefined {
    if (ranges.length === 0) return undefined;
    if (decision.range) {
        const m = decision.range.match(RANGE_RE);
        if (m) {
            const a = parseInt(m[1]!, 10);
            const b = parseInt(m[2]!, 10);
            if (a <= b) {
                for (const r of ranges) {
                    if (a >= refNum(r.startRef) && b <= refNum(r.endRef)) {
                        return { startRef: r.startRef, endRef: r.endRef };
                    }
                }
            }
        }
    }
    let best: CompressibleRange | undefined;
    for (const r of ranges) {
        if (!best || r.tokens > best.tokens) best = r;
    }
    return best ? { startRef: best.startRef, endRef: best.endRef } : undefined;
}

export function ladderMode(metadata: Record<string, unknown>): "try" | "fallback" {
    return typeof metadata[LADDER_KEY] === "number" && (metadata[LADDER_KEY] as number) >= DECIDE_FALLBACK_THRESHOLD
        ? "fallback"
        : "try";
}

/** Record one decision round. ok=true (any PARSED answer, including "no")
 *  resets the counter; ok=false increments it. */
export function recordDecision(metadata: Record<string, unknown>, ok: boolean): void {
    metadata[LADDER_KEY] = ok ? 0 : ((typeof metadata[LADDER_KEY] === "number" ? (metadata[LADDER_KEY] as number) : 0) + 1);
}

/** Called when the fallback actually fires (advisory nudge injected); resets
 *  the counter so the next failures start a fresh streak. */
export function consumeFallback(metadata: Record<string, unknown>): void {
    metadata[LADDER_KEY] = 0;
}

/** Pull the model's answer text out of a NON-streaming completion body,
 *  proto-agnostically. Returns "" when no text part exists (tool-call-only or
 *  empty response \u2014 the caller treats that as a failed parse). */
export function extractDecisionText(
    protocol: "anthropic" | "openai" | "google" | "responses",
    json: Record<string, unknown> | null,
): string {
    if (!json) return "";
    json = unwrapDataEnvelope(json);
    const parts: string[] = [];
    if (protocol === "anthropic") {
        const content = json.content;
        if (Array.isArray(content)) {
            for (const b of content) {
                const o = b as Record<string, unknown>;
                if (o && o.type === "text" && typeof o.text === "string") parts.push(o.text);
            }
        }
    } else if (protocol === "openai") {
        const choices = json.choices;
        const c0 = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
        const msg = c0 ? (c0.message as Record<string, unknown> | undefined) : undefined;
        if (msg && typeof msg.content === "string") parts.push(msg.content);
    } else if (protocol === "google") {
        const cands = json.candidates;
        const c0 = Array.isArray(cands) ? (cands[0] as Record<string, unknown> | undefined) : undefined;
        const cont = c0 ? (c0.content as Record<string, unknown> | undefined) : undefined;
        const ps = cont ? cont.parts : undefined;
        if (Array.isArray(ps)) {
            for (const p of ps) {
                const o = p as Record<string, unknown>;
                if (o && typeof o.text === "string") parts.push(o.text);
            }
        }
    } else {
        if (typeof json.output_text === "string") parts.push(json.output_text);
        const out = json.output;
        if (Array.isArray(out)) {
            for (const item of out) {
                const o = item as Record<string, unknown>;
                const c = o ? o.content : undefined;
                if (Array.isArray(c)) {
                    for (const b of c) {
                        const bo = b as Record<string, unknown>;
                        if (bo && bo.type === "output_text" && typeof bo.text === "string") parts.push(bo.text);
                    }
                }
            }
        }
    }
    return parts.join("");
}
