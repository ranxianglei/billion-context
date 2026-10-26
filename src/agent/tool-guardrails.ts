// Tool-output guardrails migrated from billion-context-pi (#3066); wired into
// createBiliPlugin for pi and omp via knobs (env > config file > default).
// Defaults since #3331: output cap 50KB ON, repetition loop-breaker ON,
// bash-timeout injection 60s ON (#3066 owner intent — an unsupervised bash
// call could hang a pi session for a whole day; BILI_GUARDRAIL_BASH_TIMEOUT=0
// restores pi-native no-default behavior, N tunes the seconds). The default
// lives in knobs.ts, NOT here: a caller resolving through knobs must be able
// to disable end-to-end by passing undefined. The temp-file dump on
// bash timeout/oversize is done by the PI HOST (path surfaced via result
// details.fullOutputPath) — we only reference it in the cap notice and never
// write the file ourselves.

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "./pi.js";

const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50_000;
const REPETITION_GUARD_DEFAULTS = { warn: 3, abort: 5 } as const;

type ContentPart = { type: string; text?: string; [key: string]: unknown };
type ToolContent = ContentPart[];

type ToolCallEventLike = {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown> & { timeout?: number };
};
type ToolResultEventLike = {
    toolName: string;
    toolCallId: string;
    content: ToolContent;
    isError?: boolean;
    details?: { fullOutputPath?: string } & Record<string, unknown>;
};

// Local view of the host ctx we touch (not imported from pi.ts to avoid a
// cycle); the real Ctx is structurally assignable since every field is optional.
type GuardrailCtx = {
    sessionManager?: { getSessionId?: () => string } | undefined;
    ui?: { notify?: (message: string, type?: string) => void } | undefined;
    abort?: (() => void) | undefined;
};

// Vendored rather than imported from the host: omp's compat bundle may omit the
// named export, and a missing named export fails the whole module at load time.
export function isBashToolResult(e: ToolResultEventLike): boolean {
    return e.toolName === "bash";
}
function isBashToolCall(e: ToolCallEventLike): boolean {
    return e.toolName === "bash";
}

/** When `defaultTimeout` is a positive number and the call omitted `timeout`,
 *  return `defaultTimeout` (inject it). Any other defaultTimeout (undefined,
 *  0, negative, NaN) means NO injection — the call goes out exactly as the
 *  model wrote it. There is no built-in fallback: the decision lives with the
 *  knobs layer (#3331 — pi's bash tool documents timeout as optional with no
 *  host default; injecting one silently is a behavior change for pi users). */
export function resolveBashTimeout(
    input: { timeout?: number },
    defaultTimeout: number | undefined,
): number | undefined {
    if (input.timeout !== undefined) return undefined;
    const d: number | undefined = defaultTimeout;
    if (d === undefined || !Number.isFinite(d) || d <= 0) return undefined;
    return d;
}

export function capToolOutput(
    content: ToolContent,
    maxBytes: number | undefined,
    fullPath?: string,
): ToolContent | undefined {
    const max = maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
    if (!Number.isFinite(max) || max <= 0) return undefined;
    const kept: ContentPart[] = [];
    const texts: string[] = [];
    for (const c of content) {
        if (c.type === "text") texts.push(c.text ?? "");
        else kept.push(c);
    }
    if (texts.length === 0) return undefined;
    const combined = texts.join("\n");
    const total = Buffer.byteLength(combined, "utf8");
    if (total <= max) return undefined;
    const head = keepHead(combined, max);
    const dropped = total - Buffer.byteLength(head, "utf8");
    kept.push({ type: "text", text: head + buildCapNotice(dropped, max, fullPath) });
    return kept;
}

const TIMEOUT_RE = /Command timed out after (\d+) seconds/;

export function detectBashTimeout(content: ToolContent): number | undefined {
    for (const c of content) {
        if (c.type !== "text") continue;
        const m = c.text?.match(TIMEOUT_RE);
        if (m) return Number(m[1]);
    }
    return undefined;
}

function appendTrailingText(content: ToolContent, notice: string): ToolContent {
    const next = [...content];
    for (let i = next.length - 1; i >= 0; i--) {
        const part = next[i];
        if (part && part.type === "text") {
            next[i] = { type: "text", text: (part.text ?? "") + notice };
            return next;
        }
    }
    next.push({ type: "text", text: notice });
    return next;
}

export function appendTimeoutNotice(content: ToolContent, secs: number): ToolContent {
    return appendTrailingText(content, buildTimeoutNotice(secs));
}

function keepHead(str: string, maxBytes: number): string {
    const buf = Buffer.from(str, "utf8");
    if (buf.length <= maxBytes) return str;
    // Walk back off a UTF-8 continuation byte so we never split a multibyte
    // sequence (entry guarantees buf.length > maxBytes, so buf[end] is in range).
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    let head = buf.subarray(0, end).toString("utf8");
    const nl = head.lastIndexOf("\n");
    if (nl >= Math.floor(maxBytes / 2)) head = head.slice(0, nl);
    return head;
}

function buildCapNotice(dropped: number, maxBytes: number, fullPath?: string): string {
    const where = fullPath
        ? `Full output saved to: ${fullPath} — read it to see everything.`
        : "To see more, narrow the query or redirect output to a file and read the relevant slice.";
    return `\n\n[ACP guardrail: output capped at ${formatBytes(maxBytes)} (~${formatBytes(dropped)} dropped). ${where}]`;
}

function buildTimeoutNotice(secs: number): string {
    const suggested = Math.min(Math.max(Math.ceil(secs * 2), 120), 3600);
    return `\n\n[ACP guardrail: command killed after ${secs}s. To give it more time, re-run the bash tool with a larger \`timeout\` argument (e.g. \`"timeout": ${suggested}\`).]`;
}

function formatBytes(n: number): string {
    return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

// --- Generic tool-call repetition guard (ported from bcp #308) ---
// A greedy small model can re-emit the same (assistant -> toolResult) pair every
// turn; token penalties can't break that attractor, so we key on byte-for-byte
// identity of consecutive calls. At `warn` append a strong warning to the
// matching toolResult; at `abort` refuse the call (block) and abort the turn.
// Any arg/tool change resets the run.
export function canonicalStringify(value: unknown): string {
    if (value === null || value === undefined || typeof value !== "object") {
        try {
            return JSON.stringify(value) ?? "null";
        } catch {
            return String(value);
        }
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(",")}}`;
}

export function repetitionFingerprint(toolName: string, input: unknown): string {
    const payload = `${toolName}\u0000${canonicalStringify(input ?? {})}`;
    try {
        return createHash("sha1").update(payload).digest("hex");
    } catch {
        return `unhashable:${toolName}`;
    }
}

type RepetitionAction = "none" | "warn" | "abort";
interface RepetitionDecision {
    action: RepetitionAction;
    count: number;
    fingerprint: string;
    toolName: string;
}

export class RepetitionTracker {
    private lastFp: string | null = null;
    private count = 0;
    constructor(private readonly thresholds: { warn: number; abort: number }) {}
    note(toolName: string, input: unknown): RepetitionDecision {
        const fp = repetitionFingerprint(toolName, input);
        if (fp === this.lastFp) this.count += 1;
        else {
            this.lastFp = fp;
            this.count = 1;
        }
        let action: RepetitionAction = "none";
        if (this.count >= this.thresholds.abort) action = "abort";
        else if (this.count >= this.thresholds.warn) action = "warn";
        return { action, count: this.count, fingerprint: fp, toolName };
    }
    reset(): void {
        this.lastFp = null;
        this.count = 0;
    }
}

function buildRepetitionWarnNotice(toolName: string, count: number): string {
    return `\n\n[ACP guardrail: you have issued ${count} CONSECUTIVE identical \`${toolName}\` calls (name + arguments byte-for-byte identical). Re-running the exact same call will not produce a new result. STOP issuing this identical call — change your approach, change the arguments, or stop and report to the user.]`;
}

function buildRepetitionAbortNotice(toolName: string, count: number): string {
    return `[ACP guardrail: BLOCKED — you issued ${count} consecutive identical \`${toolName}\` calls (byte-for-byte identical arguments). This call was refused and NOT executed. You MUST change strategy: use different arguments, a different tool, or stop and report to the user. Do not re-issue the identical call. The turn has been aborted.`;
}

export interface GuardrailOptions {
    /** Seconds to inject as `timeout` when a bash call omits it. undefined =
     *  no injection (default; pi-native semantics). */
    bashTimeout?: number;
    /** Combined text-output byte cap per tool result. undefined = 50KB
     *  default; 0 = no cap. */
    maxBytes?: number;
    repetition?: boolean | { enabled?: boolean; warn?: number; abort?: number };
}

function positiveInt(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function resolveRepetition(g: GuardrailOptions["repetition"]): { enabled: boolean; warn: number; abort: number } {
    if (g === false) return { enabled: false, warn: REPETITION_GUARD_DEFAULTS.warn, abort: REPETITION_GUARD_DEFAULTS.abort };
    const obj = g && typeof g === "object" ? g : {};
    const warn = positiveInt(obj.warn, REPETITION_GUARD_DEFAULTS.warn);
    const abort = Math.max(positiveInt(obj.abort, REPETITION_GUARD_DEFAULTS.abort), warn + 1);
    return { enabled: obj.enabled !== false, warn, abort };
}

export function wireToolGuardrails(pi: ExtensionAPI, opts: GuardrailOptions = {}): void {
    const trackers = new Map<string, RepetitionTracker>();
    const pendingWarns = new Map<string, number>();
    const repCfg = resolveRepetition(opts.repetition);
    const bashTimeout = opts.bashTimeout; // undefined = no injection (knobs decide)
    const maxBytes = opts.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;

    pi.on("tool_call", (event, rawCtx) => {
        const ctx = rawCtx as unknown as GuardrailCtx;
        const e = event as unknown as ToolCallEventLike;
        if (isBashToolCall(e)) {
            const t = resolveBashTimeout(e.input, bashTimeout);
            if (t !== undefined) e.input.timeout = t;
        }
        if (!repCfg.enabled) return;
        const sid = ctx?.sessionManager?.getSessionId?.() ?? "";
        let tracker = trackers.get(sid);
        if (!tracker) {
            tracker = new RepetitionTracker(repCfg);
            trackers.set(sid, tracker);
        }
        const decision = tracker.note(e.toolName, e.input);
        if (decision.action === "abort") {
            const msg = buildRepetitionAbortNotice(decision.toolName, decision.count);
            if (ctx?.ui?.notify) ctx?.ui?.notify(`[ACP] ${msg}`, "warning");
            try {
                ctx?.abort?.();
            } catch {
                // mid-tool abort is best-effort; the block below guarantees the refusal
            }
            return { block: true, reason: msg };
        }
        if (decision.action === "warn") {
            pendingWarns.set(e.toolCallId, decision.count);
        }
    });

    pi.on("tool_result", (event) => {
        const e = event as unknown as ToolResultEventLike;
        const isBash = isBashToolResult(e);
        const fullPath = isBash ? e.details?.fullOutputPath : undefined;
        const timeoutSecs = isBash && e.isError ? detectBashTimeout(e.content) : undefined;

        let modified: ToolContent | undefined;
        const next = capToolOutput(e.content, maxBytes, fullPath);
        if (next) modified = next;

        if (timeoutSecs !== undefined) {
            modified = appendTimeoutNotice(modified ?? e.content, timeoutSecs);
        }

        const warnCount = pendingWarns.get(e.toolCallId);
        if (warnCount !== undefined) {
            pendingWarns.delete(e.toolCallId);
            modified = appendTrailingText(modified ?? e.content, buildRepetitionWarnNotice(e.toolName, warnCount));
        }

        if (modified) return { content: modified };
    });

    pi.on("input", (event, rawCtx) => {
        const ctx = rawCtx as unknown as GuardrailCtx;
        if ((event as unknown as { source?: string }).source === "extension") return;
        trackers.get(ctx?.sessionManager?.getSessionId?.() ?? "")?.reset();
    });
    pi.on("session_shutdown", (_e, rawCtx) => {
        const ctx = rawCtx as unknown as GuardrailCtx;
        trackers.delete(ctx?.sessionManager?.getSessionId?.() ?? "");
    });
}
