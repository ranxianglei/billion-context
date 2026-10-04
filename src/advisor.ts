// #2048 — display-only "advisor": a cheap, configurable interpreter model renders
// each eligible assistant reply into plain conversational language as a SIDECAR
// VIEW. The original bytes stay 100% intact (invariant 1): this module never
// touches streamed tokens, session files, or acp_summary/nudge text — it only
// READS a tee'd copy of the response and stores rendered lines in memory.
//
// Advisor calls are proxy-INITIATED side requests that bypass the ACP pipeline
// entirely: no settleUsageReport, no noteForwardedBody, no nudge growth, no
// cache ledger, no saved-tokens accounting — excluded by construction
// (invariant 4; same discipline as #460/#1699/#1916). Every failure fails open
// (invariant 3): error/timeout/cap ⇒ no panel, main path unaffected; firing is
// strictly post-response, one call per eligible message, bounded by a process
// concurrency cap. Default OFF (src/config.ts parseAdvisorSettings).

import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import type { AdvisorSettings, ProviderRoute, ProviderRoutes } from "./config.js";
import { findRoute } from "./config.js";
import { fetchWithTimeout } from "./fetch-util.js";
import type { WireProtocol } from "./util.js";
import { proxyDispatcher } from "./upstream-proxy.js";

export const ADVISOR_TIMEOUT_MS = 15_000;
export const ADVISOR_TTL_MS = 30 * 60_000;
const ADVISOR_MAX_OUTPUT_TOKENS = 1500;
const ASSISTANT_INPUT_CAP = 24_000;
const USER_INPUT_CAP = 4_000;
const MAX_CONCURRENT = 4;
const AUTH_MAP_CAP = 32;
const MAX_LINES = 60;

type Log = (level: string, msg: string) => void;
type J = Record<string, unknown>;

function pick(obj: unknown, ...path: (string | number)[]): unknown {
    let cur: unknown = obj;
    for (const k of path) {
        if (typeof cur !== "object" || cur === null) return undefined;
        cur = (cur as J)[typeof k === "number" ? String(k) : k];
    }
    return cur;
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function arr(v: unknown): J[] { return Array.isArray(v) ? (v as J[]) : []; }

// ---------------------------------------------------------------------------
// Per-session store (in-memory only — never persisted, TTL-bounded).
// ---------------------------------------------------------------------------

export type AdvisorEntry =
    | { status: "none" }
    | { status: "pending" }
    | { status: "ready"; seq: number; lines: string[] };

interface AdvisorState {
    seq: number;
    state: "pending" | "ready" | "failed";
    lines?: string[];
    firedAt: number;
    hash?: string;
}

const store = new Map<string, AdvisorState>();

/** Latest renderable state for a session; expired/failed read as "none". */
export function advisorEntryFor(sessionId: string): AdvisorEntry {
    const s = store.get(sessionId);
    if (!s) return { status: "none" };
    if (Date.now() - s.firedAt > ADVISOR_TTL_MS) {
        store.delete(sessionId);
        return { status: "none" };
    }
    if (s.state === "ready" && s.lines) return { status: "ready", seq: s.seq, lines: s.lines };
    if (s.state === "pending") return { status: "pending" };
    return { status: "none" };
}

/** Record a firing. Returns the generation token (>0), or 0 when an identical
 *  text is already pending/ready for this session (regenerate dedupe). */
export function advisorMarkFiring(sessionId: string, hash: string): number {
    let s = store.get(sessionId);
    if (!s || Date.now() - s.firedAt > ADVISOR_TTL_MS || s.state === "failed") {
        s = { seq: (s?.seq ?? 0) + 1, state: "pending", firedAt: Date.now(), hash };
        store.set(sessionId, s);
        return s.seq;
    }
    if (s.hash === hash) return 0;
    s.seq += 1;
    s.state = "pending";
    s.lines = undefined;
    s.firedAt = Date.now();
    s.hash = hash;
    return s.seq;
}

export function advisorSettle(sessionId: string, gen: number, lines: string[]): void {
    const s = store.get(sessionId);
    if (!s || s.seq !== gen) return;
    s.state = "ready";
    s.lines = lines;
    s.firedAt = Date.now();
}

export function advisorFail(sessionId: string, gen: number): void {
    const s = store.get(sessionId);
    if (!s || s.seq !== gen) return;
    s.state = "failed";
}

export function advisorResetForTests(): void {
    store.clear();
    authMap.clear();
    inFlight = 0;
}

// ---------------------------------------------------------------------------
// Locale + prompt + input shaping.
// ---------------------------------------------------------------------------

/** "auto" → CJK-ratio heuristic on the last user message (≥30% CJK ⇒ zh-CN,
 *  else en); explicit locales pass through verbatim (BCP-47 override). */
export function resolveAdvisorLocale(locale: string, lastUserText: string | undefined): string {
    if (locale && locale !== "auto") return locale;
    if (!lastUserText) return "zh-CN";
    let cjk = 0;
    let letters = 0;
    for (const ch of lastUserText) {
        const c = ch.codePointAt(0) ?? 0;
        if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
        else if (/[A-Za-z\u00c0-\u024f]/.test(ch)) letters++;
    }
    const total = cjk + letters;
    if (total === 0) return "zh-CN";
    return cjk / total >= 0.3 ? "zh-CN" : "en";
}

/** Translator system prompt. The byte-exact pass-through rule is the #1039
 *  "arguments are user intent" discipline applied to the translator: code
 *  fences, file paths, URLs and shell commands must survive unchanged. */
export function buildAdvisorSystemPrompt(locale: string): string {
    const langLine = locale === "zh-CN"
        ? "用通俗易懂的中文口语改写，像在跟朋友解释。"
        : `Rewrite in plain conversational ${locale}, like explaining to a friend.`;
    return [
        "You are a display-only translator for an AI coding assistant's reply.",
        langLine,
        "Rules:",
        "- Code blocks, inline code, file paths, URLs, and shell commands pass through BYTE-EXACT: never translate, rename, reformat, re-indent, or drop them.",
        "- Keep every conclusion, decision, number, and caveat from the answer. Do not add information, opinions, or steps that are not there.",
        "- Concise (roughly half the length). No preamble such as \"Sure, here is...\" — output ONLY the rewritten text.",
    ].join("\n");
}

function capText(t: string, cap: number): string {
    if (t.length <= cap) return t;
    return t.slice(0, cap) + "\n…[truncated]";
}

export function buildAdvisorInput(lastUserText: string | undefined, assistantText: string): string {
    const q = lastUserText ? `Question:\n${capText(lastUserText, USER_INPUT_CAP)}\n\n` : "";
    return q + `Answer:\n${capText(assistantText, ASSISTANT_INPUT_CAP)}`;
}

/** Last real user text message (skips tool results / non-text content types). */
export function lastUserText(messages: CoreMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "user" && m.contentType === "text" && typeof m.text === "string" && m.text.trim().length > 0) return m.text;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Assistant-visible-text extraction (VISIBLE TEXT ONLY — thinking/reasoning
// excluded; those are model context, never display material).
// ---------------------------------------------------------------------------

/** Text contributed by ONE SSE event, per protocol. */
function extractSseEventText(protocol: WireProtocol, ev: J): string {
    switch (protocol) {
        case "openai":
            return str(pick(ev, "choices", 0, "delta", "content"));
        case "anthropic":
            return pick(ev, "type") === "content_block_delta" && pick(ev, "delta", "type") === "text_delta"
                ? str(pick(ev, "delta", "text"))
                : "";
        case "responses":
            return pick(ev, "type") === "response.output_text.delta" ? str(pick(ev, "delta")) : "";
        case "google":
            return arr(pick(ev, "candidates", 0, "content", "parts"))
                .filter((p) => pick(p, "thought") !== true)
                .map((p) => str(pick(p, "text")))
                .join("");
    }
}

/** Text of a COMPLETE (non-streaming) response JSON body, per protocol. */
export function extractAssistantTextFromJson(protocol: WireProtocol, json: unknown): string {
    switch (protocol) {
        case "openai": {
            const c = pick(json, "choices", 0, "message", "content");
            if (typeof c === "string") return c;
            return arr(c).filter((p) => pick(p, "type") === "text").map((p) => str(pick(p, "text"))).join("");
        }
        case "anthropic":
            return arr(pick(json, "content"))
                .filter((b) => pick(b, "type") === "text")
                .map((b) => str(pick(b, "text")))
                .join("");
        case "responses":
            return arr(pick(json, "output"))
                .filter((o) => pick(o, "type") === "message")
                .flatMap((o) => arr(pick(o, "content")).filter((c) => pick(c, "type") === "output_text"))
                .map((c) => str(pick(c, "text")))
                .join("");
        case "google":
            return arr(pick(json, "candidates", 0, "content", "parts"))
                .filter((p) => pick(p, "thought") !== true)
                .map((p) => str(pick(p, "text")))
                .join("");
    }
}

export interface AssistantTextTapper {
    /** Feed one decoded chunk of the SSE stream (visible text accumulates). */
    feed(chunk: string): void;
    /** Mark a fed stream as finished (feed-mode callers; attach mode finishes itself). */
    end(): void;
    /** Spawn a pump over a tee'd copy of the response stream. Safe to call
     *  after the other branch has started consuming (tee queues per branch). */
    attach(stream: ReadableStream<Uint8Array>): void;
    /** Resolves once the stream ended (attach-pump EOF/error, or end()). */
    settle(): Promise<void>;
    text(): string;
}

/** Incremental SSE extractor bound to one protocol. Memory is bounded by the
 *  processing lag between the two tee branches (the client-bound branch is
 *  consumed in parallel), never by full buffering. */
export function createAssistantTextTapper(protocol: WireProtocol): AssistantTextTapper {
    let buf = "";
    let out = "";
    let settled: (() => void) | undefined;
    let done = false;

    function finish(): void {
        if (done) return;
        done = true;
        settled?.();
    }

    function onData(s: string): void {
        buf += s;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const payload = t.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;
                try {
                    out += extractSseEventText(protocol, JSON.parse(payload) as J);
                } catch {
                    // keep-alive / ping / non-JSON frames — ignore
                }
            }
        }
    }

    return {
        feed(chunk) { onData(chunk); },
        attach(stream) {
            const reader = stream.getReader();
            const dec = new TextDecoder();
            const pump = async (): Promise<void> => {
                try {
                    for (;;) {
                        const { value, done: d } = await reader.read();
                        if (d) break;
                        onData(dec.decode(value, { stream: true }));
                    }
                } catch {
                    // cancelled or upstream cut — settle below either way
                } finally {
                    finish();
                    reader.releaseLock?.();
                }
            };
            void pump();
        },
        end() { finish(); },
        settle() {
            return new Promise<void>((resolve) => {
                if (done) resolve();
                else settled = resolve;
            });
        },
        text() { return out; },
    };
}

// ---------------------------------------------------------------------------
// Upstream auth capture (bounded, per normalized URL base).
//
// bili is a transparent proxy: credentials ride the CLIENT's headers, so a
// separate advisor.route can only be called with credentials bili has ALREADY
// seen in-process for that base URL (#2048 v1 narrowing — the providers table
// carries no credential fields). Same-endpoint mode needs no capture at all.
// ---------------------------------------------------------------------------

interface AuthRecord {
    authorization?: string;
    "x-api-key"?: string;
    "x-goog-api-key"?: string;
}

const authMap = new Map<string, AuthRecord>();

function normalizeBase(u: string): string {
    try {
        const x = new URL(u);
        x.search = "";
        x.hash = "";
        return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}`;
    } catch {
        return u;
    }
}

function pickAuth(headers: Record<string, string>): AuthRecord {
    const rec: AuthRecord = {};
    for (const k of ["authorization", "x-api-key", "x-goog-api-key"] as const) {
        const v = headers[k.toLowerCase()];
        if (typeof v === "string" && v.length > 0) rec[k] = v;
    }
    return rec;
}

/** Capture the auth trio of a forwarded request under its normalized base URL.
 *  Called from the single main-path chokepoint (server.ts) when advisor is on. */
export function recordUpstreamAuth(url: string, headers: Record<string, string>): void {
    const rec = pickAuth(headers);
    if (Object.keys(rec).length === 0) return;
    const key = normalizeBase(url);
    authMap.delete(key); // refresh insertion position
    authMap.set(key, rec);
    while (authMap.size > AUTH_MAP_CAP) {
        const oldest = authMap.keys().next().value;
        if (oldest === undefined) break;
        authMap.delete(oldest);
    }
}

// ---------------------------------------------------------------------------
// Firing.
// ---------------------------------------------------------------------------

let inFlight = 0;
function acquireSlot(): boolean {
    if (inFlight >= MAX_CONCURRENT) return false;
    inFlight++;
    return true;
}
function releaseSlot(): void { inFlight--; }

function defaultPathFor(url: string): string {
    try { return new URL(url).pathname; } catch { return "/"; }
}

// Captured entries are keyed by the FULL forwarded URL (credentials ride per
// endpoint), while advisor.route names a URL PREFIX — so the lookup must be
// prefix-matched with the same boundary discipline as findRoute (#2048).
function lookupAuth(routePrefix: string): AuthRecord | undefined {
    const base = normalizeBase(routePrefix);
    let bestKey = "";
    let bestRec: AuthRecord | undefined;
    for (const [k, rec] of authMap) {
        if ((k === base || k.startsWith(base + "/")) && k.length > bestKey.length) {
            bestKey = k;
            bestRec = rec;
        }
    }
    return bestRec;
}

interface Target {
    url?: string;
    auth: AuthRecord;
    label: string;
}

function resolveTarget(ctx: AdvisorFireContext): Target {
    const settings = ctx.settings;
    if (!settings.route) {
        // Default: the session's own upstream, model id swapped — the client's
        // own credentials apply by definition.
        return { url: ctx.mainUpstreamUrl, auth: pickAuth(ctx.mainHeaders), label: "same-endpoint" };
    }
    const targetRoute: ProviderRoute | undefined = findRoute(ctx.routes, settings.route);
    if (!targetRoute) {
        ctx.log("warn", `[acp-advisor] ${ctx.sessionId}: advisor.route "${settings.route}" matches no providers-table entry — panel suppressed`);
        return { auth: {}, label: "bad-route" };
    }
    if (targetRoute.protocol && targetRoute.protocol !== ctx.protocol) {
        ctx.log("warn", `[acp-advisor] ${ctx.sessionId}: advisor.route "${settings.route}" declares protocol "${targetRoute.protocol}", request is "${ctx.protocol}" — panel suppressed`);
        return { auth: {}, label: "protocol-mismatch" };
    }
    const auth = lookupAuth(settings.route);
    if (!auth) {
        ctx.log("warn", `[acp-advisor] ${ctx.sessionId}: no credentials observed yet for advisor.route "${settings.route}" — panel suppressed (fail-open)`);
        return { auth: {}, label: "no-auth" };
    }
    // Retarget the main endpoint's PATH onto the route base (route keys are
    // URL prefixes). For google the model lives IN the path — swap it there.
    let suffix = defaultPathFor(ctx.mainUpstreamUrl);
    if (ctx.protocol === "google") {
        suffix = suffix.replace(/models\/[^/:]+/, `models/${encodeURIComponent(ctx.settings.model)}`);
    }
    return { url: settings.route + suffix, auth, label: "separate-route" };
}

function buildBody(protocol: WireProtocol, model: string, system: string, user: string): unknown {
    switch (protocol) {
        case "openai":
            return { model, stream: false, max_tokens: ADVISOR_MAX_OUTPUT_TOKENS, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
        case "anthropic":
            return { model, stream: false, max_tokens: ADVISOR_MAX_OUTPUT_TOKENS, system, messages: [{ role: "user", content: user }] };
        case "responses":
            return { model, stream: false, max_output_tokens: ADVISOR_MAX_OUTPUT_TOKENS, instructions: system, input: [{ role: "user", content: user }] };
        case "google":
            return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { candidateTokenCount: ADVISOR_MAX_OUTPUT_TOKENS } };
    }
}

export interface AdvisorFireContext {
    sessionId: string;
    protocol: WireProtocol;
    assistantText: string;
    lastUserText?: string;
    settings: AdvisorSettings;
    routes: ProviderRoutes;
    mainUpstreamUrl: string;
    mainHeaders: Record<string, string>;
    proxyUrl?: string;
    log: Log;
    /** Test knob; production always uses ADVISOR_TIMEOUT_MS. */
    timeoutMs?: number;
}

/** Fire one advisor render for an eligible finished assistant reply. NEVER
 *  throws — every failure path fails open (no panel, main path untouched). */
export async function fireAdvisor(ctx: AdvisorFireContext): Promise<void> {
    const text = ctx.assistantText.trim();
    if (text.length < ctx.settings.minChars) return;
    let gen = 0;
    let slot = false;
    try {
        const hash = createHash("sha1").update(text).digest("hex");
        gen = advisorMarkFiring(ctx.sessionId, hash);
        if (gen === 0) return;
        slot = acquireSlot();
        if (!slot) {
            advisorFail(ctx.sessionId, gen);
            ctx.log("info", `[acp-advisor] ${ctx.sessionId}: skipped — concurrent advisor calls at cap`);
            return;
        }
        const target = resolveTarget(ctx);
        if (!target.url) {
            advisorFail(ctx.sessionId, gen);
            return;
        }
        const locale = resolveAdvisorLocale(ctx.settings.locale, ctx.lastUserText);
        const body = buildBody(ctx.protocol, ctx.settings.model, buildAdvisorSystemPrompt(locale), buildAdvisorInput(ctx.lastUserText, text));
        // fetchWithTimeout (not raw fetch): idle-timeout watchdog + the repo's
        // undici agent defaults, so hidden transport timeouts can't fire first.
        const { response: resp, clearTimer } = await fetchWithTimeout(
            target.url,
            {
                method: "POST",
                headers: { "content-type": "application/json", ...target.auth },
                body: JSON.stringify(body),
                dispatcher: ctx.proxyUrl ? proxyDispatcher(ctx.proxyUrl) : undefined,
            },
            ctx.timeoutMs ?? ADVISOR_TIMEOUT_MS,
        );
        try {
            if (!resp.ok) {
                advisorFail(ctx.sessionId, gen);
                ctx.log("info", `[acp-advisor] ${ctx.sessionId}: upstream HTTP ${resp.status} (${target.label}) — panel suppressed`);
                return;
            }
            const json: unknown = await resp.json();
            const rendered = extractAssistantTextFromJson(ctx.protocol, json).trim();
            if (!rendered) {
                advisorFail(ctx.sessionId, gen);
                ctx.log("info", `[acp-advisor] ${ctx.sessionId}: empty advisor response (${target.label}) — panel suppressed`);
                return;
            }
            const lines = rendered.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
            advisorSettle(ctx.sessionId, gen, lines.slice(0, MAX_LINES));
            ctx.log("info", `[acp-advisor] ${ctx.sessionId}: rendered ${rendered.length} chars via ${ctx.settings.model} (${target.label})`);
        } finally {
            clearTimer();
        }
    } catch (err) {
        if (gen) advisorFail(ctx.sessionId, gen);
        ctx.log("info", `[acp-advisor] ${ctx.sessionId}: advisor call failed (${err instanceof Error ? err.message : String(err)}) — fail-open, main path unaffected`);
    } finally {
        if (slot) releaseSlot();
    }
}
