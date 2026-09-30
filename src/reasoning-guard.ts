import { fetchWithTimeout } from "./fetch-util.js";
import { normalizeSseLineEndings } from "./sse-util.js";
import { awaitDrain } from "./server/stream-io.js";

/** Minimal server-response surface the guard writes SSE frames to. Kept apart
 *  from node:http so the live fold can be unit-tested against a recording sink. */
export interface SseSink {
    headersSent: boolean;
    writableEnded: boolean;
    writableNeedDrain?: boolean;
    destroyed?: boolean;
    writeHead(status: number, headers: Record<string, string>): void;
    write(chunk: string | Uint8Array): unknown;
    end(): void;
    once(event: "drain" | "close" | "error", cb: () => void): unknown;
}

/** Guard against OpenAI gpt-5.x/gpt-6.x "lattice" reasoning truncation (#739): these
 *  models intermittently stop at exactly base*n+offset reasoning tokens (default
 *  518n-2 -> 516,1034,...) mid-thought. On a matched-model terminal round hitting
 *  the lattice AND carrying an encrypted_content blob, re-send replaying its own
 *  reasoning plus a nudge (up to N rounds), then fold into ONE response with true
 *  summed usage. Detection is data-driven (config); recovery is generic. Scope is
 *  expressed by WHERE the config sits in the three-level tree (global/provider/model);
 *  the strict signature (exact lattice hit + encrypted_content + no tool calls) limits
 *  actual action. Default off. */

export interface ReasoningGuardConfig {
    enabled?: boolean;
    /** Max continuation rounds after the initial round (default 3). */
    maxContinue?: number;
    /** Max lattice tier n allowed to continue (default 6); 0 = unlimited. */
    maxTierN?: number;
    /** Nudge text appended as a commentary message (default "Continue thinking..."). */
    markerText?: string;
    /** Lattice base (default 518); truncated tokens == base*n + offset. */
    base?: number;
    /** Lattice offset (default -2); gpt-5.x/gpt-6.x truncate at 518n-2. */
    offset?: number;
    debugLog?: boolean;
}

const MIN_N = 1;
const DEFAULT_MARKER = "Continue thinking...";
const ENC_INCLUDE = "reasoning.encrypted_content";
const TERMINAL_TYPES = new Set(["response.completed", "response.failed", "response.incomplete"]);

interface ResolvedGuard {
    maxContinue: number;
    maxTierN: number;
    markerText: string;
    base: number;
    offset: number;
    debugLog: boolean;
}

type Usage = Record<string, unknown>;

function resolveGuardConfig(cfg: ReasoningGuardConfig | undefined): ResolvedGuard {
    const c = cfg ?? {};
    return {
        maxContinue: numOr(c.maxContinue, 3),
        maxTierN: numOr(c.maxTierN, 6),
        markerText: typeof c.markerText === "string" && c.markerText.trim() ? c.markerText.trim() : DEFAULT_MARKER,
        base: numOr(c.base, 518),
        offset: numOr(c.offset, -2),
        debugLog: c.debugLog === true,
    };
}

function numOr(v: unknown, dflt: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

export function reasoningGuardEngages(cfg: ReasoningGuardConfig | undefined): boolean {
    return cfg?.enabled === true;
}

export function reasoningTokens(usage: Usage | null | undefined): number | null {
    if (!usage) return null;
    const details = usage["output_tokens_details"] as Usage | undefined;
    const rt = details?.["reasoning_tokens"];
    return typeof rt === "number" && Number.isFinite(rt) ? rt : null;
}

/** n when tokens == base*n + offset (e.g. 518n-2 -> 516,1034,...), else null. */
export function tierN(tokens: number | null, base: number, offset: number): number | null {
    if (tokens === null || base <= 0) return null;
    const t = tokens - offset;
    if (t < base * MIN_N || t % base !== 0) return null;
    const n = t / base;
    return Number.isInteger(n) && n >= MIN_N ? n : null;
}

export function inContinueWindow(n: number | null, maxTierN: number): boolean {
    if (n === null || n < MIN_N) return false;
    if (maxTierN !== 0 && n > maxTierN) return false;
    return true;
}

export function hasEncryptedContent(reasoningItems: Array<Record<string, unknown>>): boolean {
    if (reasoningItems.length === 0) return false;
    const ec = reasoningItems[reasoningItems.length - 1]?.["encrypted_content"];
    return typeof ec === "string" && ec.length > 0;
}

/** "truncation" when the terminal reasoning hits the lattice within window, else "". */
export function continueReason(usage: Usage | null, base: number, offset: number, maxTierN: number): "truncation" | "" {
    const n = tierN(reasoningTokens(usage), base, offset);
    return inContinueWindow(n, maxTierN) ? "truncation" : "";
}

function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function sumUsage(acc: Usage, usage: Usage | null): void {
    if (!usage) return;
    for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const) {
        const v = usage[key];
        if (typeof v === "number") acc[key] = num(acc[key]) + v;
    }
    const inDetails = usage["input_tokens_details"] as Usage | undefined;
    if (inDetails && typeof inDetails.cached_tokens === "number") {
        const accIn = (acc["input_tokens_details"] as Usage) ?? {};
        accIn.cached_tokens = num(accIn.cached_tokens) + inDetails.cached_tokens;
        acc["input_tokens_details"] = accIn;
    }
    const rt = reasoningTokens(usage);
    if (rt !== null) {
        const accOut = (acc["output_tokens_details"] as Usage) ?? {};
        accOut.reasoning_tokens = num(accOut.reasoning_tokens) + rt;
        acc["output_tokens_details"] = accOut;
    }
}

/** Reconstruct the usage reported on the folded response: input from the first
 *  round (prompt sent once), output = summed reasoning + final non-reasoning
 *  part, total = input + output. Preserves first-round cached_tokens. */
export function agentUsage(first: Usage | null, summed: Usage, finalRound: Usage | null, flushedFinal: boolean): Usage {
    const f = first ?? {};
    const inTok = num(f.input_tokens);
    const fDetails = f["input_tokens_details"] as Usage | undefined;
    const cached = fDetails && typeof fDetails.cached_tokens === "number" ? fDetails.cached_tokens : null;
    const sOut = summed["output_tokens_details"] as Usage | undefined;
    const reason = sOut && typeof sOut.reasoning_tokens === "number" ? sOut.reasoning_tokens : 0;
    let finalPart = 0;
    if (flushedFinal && finalRound) {
        const out = num(finalRound.output_tokens);
        const rt = reasoningTokens(finalRound) ?? 0;
        finalPart = Math.max(0, out - rt);
    }
    const usage: Usage = {
        input_tokens: inTok,
        output_tokens: reason + finalPart,
        total_tokens: inTok + reason + finalPart,
        output_tokens_details: { reasoning_tokens: reason },
    };
    if (cached !== null) usage["input_tokens_details"] = { cached_tokens: cached };
    return usage;
}

export function buildTerminalEvent(opts: {
    upstreamTerminal: Record<string, unknown> | null;
    baseResponse: Record<string, unknown> | null;
    output: Array<Record<string, unknown>>;
    usage: Usage;
    rounds: Array<Record<string, unknown>>;
    billed: Usage;
    stoppedReason: string;
    incompleteReason: string;
}): Record<string, unknown> {
    const tresp = (opts.upstreamTerminal?.["response"] as Usage) ?? {};
    const resp: Record<string, unknown> = { ...(opts.baseResponse ?? tresp) };
    resp.output = opts.output;
    resp.usage = opts.usage;
    const metadata: Record<string, unknown> = { ...((resp.metadata as Record<string, unknown>) ?? {}) };
    metadata.proxy_rounds = opts.rounds;
    metadata.proxy_billed_usage = opts.billed;
    if (opts.stoppedReason) metadata.proxy_stopped_reason = opts.stoppedReason;
    resp.metadata = metadata;
    if (opts.incompleteReason) {
        resp.status = "incomplete";
        resp.incomplete_details = { reason: opts.incompleteReason };
        return { type: "response.incomplete", response: resp };
    }
    const status = typeof tresp.status === "string" ? tresp.status : "completed";
    resp.status = status;
    if (tresp.incomplete_details !== undefined) resp.incomplete_details = tresp.incomplete_details;
    const evType = typeof opts.upstreamTerminal?.["type"] === "string" ? opts.upstreamTerminal["type"] : "response.completed";
    return { type: evType, response: resp };
}

export function commentaryNudge(markerText: string): Record<string, unknown> {
    return {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: markerText }],
        phase: "commentary",
    };
}

export function nextRoundBody(baseBody: Record<string, unknown>, inputItems: unknown[]): Record<string, unknown> {
    const body: Record<string, unknown> = { ...baseBody };
    body.stream = true;
    body.input = inputItems;
    const includeRaw = Array.isArray(body.include) ? (body.include as unknown[]) : [];
    const include = includeRaw.filter((x): x is string => typeof x === "string");
    if (!include.includes(ENC_INCLUDE)) include.push(ENC_INCLUDE);
    body.include = include;
    delete body.previous_response_id;
    return body;
}

interface GuardParams {
    firstResponse: Response;
    clearFirstTimer: () => void;
    upstreamUrl: string;
    reqHeaders: Record<string, string>;
    dispatcher?: object;
    originalBody: Buffer | string;
    signal: AbortSignal;
    res: SseSink;
    config: ReasoningGuardConfig;
    log: (msg: string) => void;
}

interface FoldState {
    cfg: ResolvedGuard;
    baseBody: Record<string, unknown>;
    origInput: unknown[];
    replayTail: unknown[];
    summedUsage: Usage;
    firstUsage: Usage | null;
    finalOutput: Array<Record<string, unknown>>;
    roundsInfo: Array<Record<string, unknown>>;
    dsOI: number;
    seq: number;
    baseResponse: Record<string, unknown> | null;
    roundNo: number;
    roundReasoning: Array<Record<string, unknown>>;
    kind: Map<number, "reasoning" | "buffered">;
    oiToDS: Map<number, number>;
    buffered: Array<{ oi: number; item: Record<string, unknown>; events: Array<Record<string, unknown>> }>;
    terminal: Record<string, unknown> | null;
    usage: Usage | null;
}

const DONE_SENTINEL = Symbol("done");

function parseFrame(frame: string): Record<string, unknown> | typeof DONE_SENTINEL | null {
    let payload = "";
    for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) payload += (payload ? "\n" : "") + line.slice(5).replace(/^ /, "");
    }
    const trimmed = payload.trim();
    if (trimmed === "") return null;
    if (trimmed === "[DONE]") return DONE_SENTINEL;
    try {
        return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function writeEvent(res: SseSink, ev: Record<string, unknown>): void {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

function stamp(st: FoldState, ev: Record<string, unknown>): void {
    ev.sequence_number = st.seq++;
}

function processEvent(ev: Record<string, unknown>, st: FoldState, res: SseSink): Record<string, unknown> | null {
    const etype = typeof ev.type === "string" ? ev.type : "";
    if (etype === "response.created" || etype === "response.in_progress") {
        if (st.roundNo === 1) {
            if (etype === "response.created" && typeof ev.response === "object" && ev.response !== null) {
                st.baseResponse = ev.response as Record<string, unknown>;
            }
            stamp(st, ev);
            writeEvent(res, ev);
        }
        return null;
    }
    if (TERMINAL_TYPES.has(etype)) {
        st.terminal = ev;
        const resp = ev.response as Usage | undefined;
        st.usage = resp && typeof resp === "object" ? ((resp.usage as Usage) ?? null) : null;
        return ev;
    }
    const oiRaw = ev.output_index;
    const oi = typeof oiRaw === "number" ? oiRaw : -1;
    if (etype === "response.output_item.added") {
        const item = (typeof ev.item === "object" && ev.item !== null) ? (ev.item as Record<string, unknown>) : {};
        const itemType = typeof item.type === "string" ? item.type : "";
        if (itemType === "reasoning") {
            st.kind.set(oi, "reasoning");
            st.oiToDS.set(oi, st.dsOI);
            ev.output_index = st.dsOI;
            st.dsOI++;
            stamp(st, ev);
            writeEvent(res, ev);
        } else {
            st.kind.set(oi, "buffered");
            st.buffered.push({ oi, item, events: [ev] });
        }
        return null;
    }
    const k = st.kind.get(oi);
    if (k === "reasoning") {
        const ds = st.oiToDS.get(oi);
        if (ds !== undefined) ev.output_index = ds;
        if (etype === "response.output_item.done" && typeof ev.item === "object" && ev.item !== null) {
            const item = ev.item as Record<string, unknown>;
            st.roundReasoning.push(item);
            st.finalOutput.push(item);
        }
        stamp(st, ev);
        writeEvent(res, ev);
    } else if (k === "buffered") {
        const entry = st.buffered.find((b) => b.oi === oi);
        if (entry) {
            entry.events.push(ev);
            if (etype === "response.output_item.done" && typeof ev.item === "object" && ev.item !== null) {
                entry.item = ev.item as Record<string, unknown>;
            }
        }
    } else {
        stamp(st, ev);
        writeEvent(res, ev);
    }
    return null;
}

async function consumeRound(
    stream: ReadableStream<Uint8Array>,
    st: FoldState,
    res: SseSink,
): Promise<{ terminal: Record<string, unknown> } | { error: string }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            buf = normalizeSseLineEndings(buf);
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const ev = parseFrame(frame);
                if (ev === null || ev === DONE_SENTINEL) continue;
                const term = processEvent(ev, st, res);
                if (term) return { terminal: term };
            }
        }
        return { error: "upstream_eof" };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    } finally {
        reader.releaseLock();
    }
}

function endRound(st: FoldState): void {
    sumUsage(st.summedUsage, st.usage);
    if (st.roundNo === 1) st.firstUsage = cloneUsage(st.usage);
    const rt = reasoningTokens(st.usage);
    const n = tierN(rt, st.cfg.base, st.cfg.offset);
    st.roundsInfo.push({ round: st.roundNo, reasoning_tokens: rt ?? 0, n: n ?? 0 });
}

function shouldContinue(st: FoldState): "truncation" | "" {
    if (!st.terminal) return "";
    const etype = typeof st.terminal.type === "string" ? st.terminal.type : "";
    if (etype !== "response.completed") return "";
    const reason = continueReason(st.usage, st.cfg.base, st.cfg.offset, st.cfg.maxTierN);
    if (reason === "") return "";
    if (!hasEncryptedContent(st.roundReasoning)) return "";
    if (st.roundNo > st.cfg.maxContinue) return "";
    st.roundsInfo[st.roundsInfo.length - 1]!.continue_reason = reason;
    return reason;
}

function prepareNextRound(st: FoldState): void {
    st.replayTail.push(...st.roundReasoning, commentaryNudge(st.cfg.markerText));
    st.roundReasoning = [];
    st.kind = new Map();
    st.oiToDS = new Map();
    st.buffered = [];
    st.terminal = null;
    st.usage = null;
}

function flushCleanStop(st: FoldState, res: SseSink): void {
    for (const entry of st.buffered) {
        for (const ev of entry.events) {
            if ("output_index" in ev) ev.output_index = st.dsOI;
            stamp(st, ev);
            writeEvent(res, ev);
        }
        st.dsOI++;
        st.finalOutput.push(entry.item);
    }
}

function stoppedReason(st: FoldState): string {
    if (st.roundNo <= 1) return "";
    const etype = typeof st.terminal?.type === "string" ? st.terminal.type : "";
    if (etype !== "response.completed") return "";
    if (continueReason(st.usage, st.cfg.base, st.cfg.offset, st.cfg.maxTierN) === "") return "";
    if (!hasEncryptedContent(st.roundReasoning)) return "no_encrypted_content";
    if (st.roundNo > st.cfg.maxContinue) return "max_continue";
    const n = tierN(reasoningTokens(st.usage), st.cfg.base, st.cfg.offset);
    if (!inContinueWindow(n, st.cfg.maxTierN)) return "tier_out_of_window";
    return "";
}

function buildIncomplete(st: FoldState, reason: string): Record<string, unknown> {
    const usage = agentUsage(st.firstUsage, st.summedUsage, st.usage, false);
    return buildTerminalEvent({
        upstreamTerminal: null,
        baseResponse: st.baseResponse,
        output: st.finalOutput,
        usage,
        rounds: st.roundsInfo,
        billed: st.summedUsage,
        stoppedReason: "",
        incompleteReason: reason,
    });
}

function cloneUsage(u: Usage | null): Usage | null {
    if (!u) return null;
    return JSON.parse(JSON.stringify(u)) as Usage;
}

async function pipeThroughRaw(stream: ReadableStream<Uint8Array>, res: SseSink): Promise<void> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.destroyed || res.writableEnded) break;
            res.write(value);
            if (res.writableNeedDrain) await awaitDrain(res);
        }
    } finally {
        reader.releaseLock();
        if (!res.writableEnded) res.end();
    }
}

export async function runReasoningGuard(p: GuardParams): Promise<void> {
    const cfg = resolveGuardConfig(p.config);
    let bodyStr: string;
    try {
        bodyStr = typeof p.originalBody === "string" ? p.originalBody : p.originalBody.toString("utf8");
    } catch {
        bodyStr = "";
    }
    let baseBody: Record<string, unknown>;
    try {
        baseBody = JSON.parse(bodyStr) as Record<string, unknown>;
    } catch {
        p.log("reasoning-guard: failed to parse request body; passing round 1 through verbatim");
        const rawBody = p.firstResponse.body;
        if (!rawBody) {
            if (!p.res.headersSent) p.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (!p.res.writableEnded) p.res.end();
            p.clearFirstTimer();
            return;
        }
        await pipeThroughRaw(rawBody, p.res);
        p.clearFirstTimer();
        return;
    }
    const origInput = Array.isArray(baseBody.input) ? (baseBody.input as unknown[]) : [];
    const st: FoldState = {
        cfg,
        baseBody,
        origInput,
        replayTail: [],
        summedUsage: {},
        firstUsage: null,
        finalOutput: [],
        roundsInfo: [],
        dsOI: 0,
        seq: 0,
        baseResponse: null,
        roundNo: 1,
        roundReasoning: [],
        kind: new Map(),
        oiToDS: new Map(),
        buffered: [],
        terminal: null,
        usage: null,
    };

    const finish = (ev: Record<string, unknown>): void => {
        if (!p.res.headersSent) p.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (!p.res.writableEnded) {
            writeEvent(p.res, ev);
            p.res.end();
        }
    };

    const firstBody = p.firstResponse.body;
    if (!firstBody) {
        finish(buildIncomplete(st, "no_body"));
        p.clearFirstTimer();
        return;
    }
    let result = await consumeRound(firstBody, st, p.res);
    p.clearFirstTimer();

    for (;;) {
        if ("error" in result) {
            finish(buildIncomplete(st, result.error));
            return;
        }
        endRound(st);
        const cont = shouldContinue(st);
        if (cfg.debugLog) p.log(`reasoning-guard round=${st.roundNo} rt=${reasoningTokens(st.usage)} continue=${cont || "-"}`);
        if (cont) {
            prepareNextRound(st);
            st.roundNo++;
            const nextBody = nextRoundBody(st.baseBody, [...st.origInput, ...st.replayTail]);
            let roundRes: Awaited<ReturnType<typeof fetchWithTimeout>>;
            try {
                roundRes = await fetchWithTimeout(p.upstreamUrl, {
                    method: "POST",
                    headers: p.reqHeaders,
                    body: JSON.stringify(nextBody),
                    dispatcher: p.dispatcher,
                }, undefined, p.signal);
            } catch {
                finish(buildIncomplete(st, "upstream_error"));
                return;
            }
            const contBody = roundRes.response.body;
            roundRes.stopIdleTimer();
            result = contBody ? await consumeRound(contBody, st, p.res) : { error: "no_body" };
            continue;
        }
        flushCleanStop(st, p.res);
        const usage = agentUsage(st.firstUsage, st.summedUsage, st.usage, true);
        finish(buildTerminalEvent({
            upstreamTerminal: st.terminal,
            baseResponse: st.baseResponse,
            output: st.finalOutput,
            usage,
            rounds: st.roundsInfo,
            billed: st.summedUsage,
            stoppedReason: stoppedReason(st),
            incompleteReason: "",
        }));
        return;
    }
}
