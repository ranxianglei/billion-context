import type { WireProtocol } from "./util.js";
import { log as loggerLog } from "./logger.js";
import {
    decideOutputSteering,
    renderSteeringBlock,
    clampEffortToFloor,
    resolveOutputSteeringConfig,
    DEFAULT_OUTPUT_STEERING_CONFIG,
} from "acp-kernel";
import type { OutputSteeringConfig, StructuralMessage, StructuralBlock } from "acp-kernel";
export type { OutputSteeringConfig };
export { resolveVerbosityLevel } from "acp-kernel";

/**
 * Output-side compression (#1093): verbosity steering + effort routing.
 *
 * Conceptually ported from headroomlabs-ai/headroom (docs/proposals/output-token-reduction.md);
 * the DECISION logic (L1–L4 wording, structural turn classification, effort clamp,
 * config resolution) is delegated to acp-kernel as the single source of truth shared
 * with the agent side. This module keeps only wire-local landing: mapping each wire's
 * tool-result shape onto the kernel's StructuralMessage model, appending the directive
 * to each system carrier (tail/skip-if-absent/idempotent), and the numeric budget floors.
 * Output tokens cost more than input and are billed the instant they stream out,
 * so the only lever is at request time. Two levers, both applied at the proxy
 * forward boundary AFTER every other body mutation, on the FINAL wire body:
 *
 *   1. Verbosity steering — append a deterministic conciseness directive at the
 *      TAIL of the system prompt (levels L0–L4, default L2; L0 = none). Never
 *      prepend: prepending shifts the client's own prompt bytes and busts the
 *      prefix cache. The directive is sentinel-wrapped and re-applied idempotently,
 *      so retries never accumulate it and a level change replaces in place.
 *
 *   2. Effort routing — classify the last user turn STRUCTURALLY (block
 *      composition only, no content pattern-matching); on a mechanical
 *      continuation (clean tool result, no error) LOWER an explicitly-present
 *      effort field toward its minimum. Clamp-only: NEVER inject a field the
 *      client didn't send (models without effort support 400 on it), and NEVER
 *      toggle `thinking.type` (disabling thinking over a history that carries
 *      thinking blocks 400s and busts the cache tier).
 *
 * Default OFF. Config: billion-context.json `outputSteering` block (global, with
 * optional per-provider route overlay). Hard acceptance: no prefix-cache hit-rate
 * regression (compare `[acp-usage]` cache hit %).
 */

/** Sentinel wrapping the steering directive. Bili-owned (distinct from
 *  headroom's) so a body that passed through both proxies never collides. */
const SENTINEL = "<bili_output_steering>";
const SUFFIX = "</bili_output_steering>";

/** Steering directive block for a level, rendered by acp-kernel (single source of
 *  truth for the wording, shared with the agent side). L0 returns null (no
 *  directive). BYTE-STABLE across releases: editing the kernel wording is a
 *  prefix-cache bust for every session pinned at that level. */
export function steeringText(level: number): string | null {
    return renderSteeringBlock(level, SENTINEL);
}

/** Idempotently place `block` in `existing`: replace the existing sentinel block
 *  in place (preserving surrounding text) if one is present, else append at the
 *  tail. Returns [updated, changed]. The slice skips PAST the old SUFFIX so a
 *  re-apply neither duplicates the closing tag nor grows the block. */
function replaceOrAppend(existing: string, block: string): [string, boolean] {
    const start = existing.indexOf(SENTINEL);
    if (start >= 0) {
        const found = existing.indexOf(SUFFIX, start);
        const end = found < 0 ? existing.length : found + SUFFIX.length;
        const prefix = existing.slice(0, start).replace(/\s+$/, "");
        const suffix = existing.slice(end).replace(/^\n+/, "");
        const parts = [prefix, block, suffix].filter((p) => p.length > 0);
        const updated = parts.join("\n\n");
        return [updated, updated !== existing];
    }
    const trimmed = existing.trim();
    const updated = trimmed.length > 0 ? `${existing.replace(/\s+$/, "")}\n\n${block}` : block;
    return [updated, updated !== existing];
}

// ---- Config ----

export const DEFAULT_OUTPUT_STEERING: OutputSteeringConfig = DEFAULT_OUTPUT_STEERING_CONFIG;

/** Validate an `outputSteering`-shaped value via acp-kernel's resolver (single
 *  source of truth for the schema, defaults, and warnings). Malformed fields fall
 *  back to defaults WITH warnings (honest output); returns undefined when the
 *  value is not an object (caller substitutes DEFAULT_OUTPUT_STEERING). */
export function parseOutputSteering(v: unknown): OutputSteeringConfig | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const { config, warnings } = resolveOutputSteeringConfig(v);
    for (const w of warnings) loggerLog("warn", w);
    return config;
}

// ---- Turn normalization (wire-specific; feeds acp-kernel's classifier) ----
// Each wire names its tool-result shape differently (anthropic tool_result
// blocks / openai role:"tool" messages / responses *_call_output items / google
// functionResponse parts), so only bili can map them onto the kernel's
// protocol-neutral StructuralMessage model. The DECISION (turn kind, whether to
// lower effort, verbosity level) is acp-kernel's decideOutputSteering — shared
// with the agent side, single source of truth.

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function normalizeAnthropic(messages: unknown): StructuralMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const last = asRecord(messages[messages.length - 1]);
    if (!last || last.role !== "user") return [{ role: "user", text: "" }];
    const content = last.content;
    if (typeof content === "string") return [{ role: "user", text: content }];
    if (!Array.isArray(content) || content.length === 0) return [{ role: "user", text: "" }];
    const blocks: StructuralBlock[] = [];
    for (const raw of content) {
        const b = asRecord(raw);
        if (!b) return [{ role: "user", text: "" }];
        const t = b.type;
        if (t === "tool_result") blocks.push({ kind: "tool_result", isError: b.is_error === true });
        else if (t === "text" || t === "image" || t === "document") blocks.push({ kind: t });
        else return [{ role: "user", text: "" }];
    }
    return [{ role: "user", blocks }];
}

function normalizeOpenAi(messages: unknown): StructuralMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const last = asRecord(messages[messages.length - 1]);
    if (!last) return [{ role: "user", text: "" }];
    if (last.role === "tool") {
        let i = messages.length - 1;
        while (i >= 0 && asRecord(messages[i])?.role === "tool") i--;
        const n = messages.length - 1 - i;
        const blocks: StructuralBlock[] = [];
        for (let k = 0; k < n; k++) blocks.push({ kind: "tool_result" });
        return [{ role: "user", blocks }];
    }
    if (last.role === "user") {
        const c = last.content;
        if (typeof c === "string") return [{ role: "user", text: c }];
        if (Array.isArray(c)) {
            for (const raw of c) {
                const b = asRecord(raw);
                if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) return [{ role: "user", blocks: [{ kind: "text" }] }];
            }
        }
    }
    return [{ role: "user", text: "" }];
}

const RESPONSES_OUTPUT_TYPES = new Set([
    "custom_tool_call_output",
    "function_call_output",
    "local_shell_call_output",
    "apply_patch_call_output",
]);
const RESPONSES_NEUTRAL_TYPES = new Set([
    "message",
    "function_call",
    "custom_tool_call",
    "local_shell_call",
    "apply_patch_call",
    "reasoning",
]);

function responsesIsUserSignal(item: Record<string, unknown>): boolean {
    if (item.type === "input_text") return typeof item.text === "string" && item.text.trim() !== "";
    if (item.type === "input_image" || item.type === "input_file") return true;
    if (item.role === "user") {
        const c = item.content ?? item.input;
        if (typeof c === "string") return c.trim() !== "";
        if (Array.isArray(c)) {
            for (const raw of c) {
                const b = asRecord(raw);
                if (!b) continue;
                if ((b.type === "input_text" || b.type === "text") && typeof b.text === "string" && b.text.trim()) return true;
                if (b.type === "input_image" || b.type === "input_file") return true;
            }
        }
    }
    return false;
}

function normalizeResponses(input: unknown): StructuralMessage[] {
    if (typeof input === "string") return [{ role: "user", text: input }];
    if (!Array.isArray(input) || input.length === 0) return [{ role: "user", text: "" }];
    const last = asRecord(input[input.length - 1]);
    if (last && responsesIsUserSignal(last)) return [{ role: "user", blocks: [{ kind: "text" }] }];
    let foundOutput = false;
    for (let i = input.length - 1; i >= 0; i--) {
        const item = asRecord(input[i]);
        if (!item) break;
        const t = typeof item.type === "string" ? item.type : "";
        if (RESPONSES_OUTPUT_TYPES.has(t)) {
            foundOutput = true;
            break;
        }
        if (RESPONSES_NEUTRAL_TYPES.has(t)) continue;
        break;
    }
    if (foundOutput) return [{ role: "user", blocks: [{ kind: "tool_result" }] }];
    return [{ role: "user", text: "" }];
}

function normalizeGoogle(contents: unknown): StructuralMessage[] {
    if (!Array.isArray(contents) || contents.length === 0) return [];
    const last = asRecord(contents[contents.length - 1]);
    if (!last || last.role !== "user") return [{ role: "user", text: "" }];
    const parts = last.parts;
    if (!Array.isArray(parts) || parts.length === 0) return [{ role: "user", text: "" }];
    const blocks: StructuralBlock[] = [];
    for (const raw of parts) {
        const p = asRecord(raw);
        if (!p) return [{ role: "user", text: "" }];
        if (p.functionResponse) blocks.push({ kind: "tool_result" });
        else if (typeof p.text === "string") {
            if (p.text.trim() !== "") blocks.push({ kind: "text" });
        } else if (p.inlineData || p.fileData || p.videoMetadata) blocks.push({ kind: "image" });
        else return [{ role: "user", text: "" }];
    }
    return [{ role: "user", blocks }];
}

function toStructural(protocol: WireProtocol, obj: Record<string, unknown>): StructuralMessage[] {
    switch (protocol) {
        case "anthropic": return normalizeAnthropic(obj.messages);
        case "openai": return normalizeOpenAi(obj.messages);
        case "responses": return normalizeResponses(obj.input);
        case "google": return normalizeGoogle(obj.contents);
    }
}

// ---- Verbosity steering (append to the tail of the system prompt) ----

function steerSystemPrompt(obj: Record<string, unknown>, protocol: WireProtocol, level: number): boolean {
    const block = steeringText(level);
    if (!block) return false;
    switch (protocol) {
        case "anthropic": return steerAnthropicSystem(obj, block);
        case "openai": return steerOpenAiSystem(obj, block);
        case "responses": return steerResponsesInstructions(obj, block);
        case "google": return steerGoogleSystem(obj, block);
    }
}

function steerAnthropicSystem(obj: Record<string, unknown>, block: string): boolean {
    const sys = obj.system;
    if (sys === undefined) return false; // skip-if-absent: never fabricate a system prompt
    if (typeof sys === "string") {
        const [updated, changed] = replaceOrAppend(sys, block);
        if (changed) obj.system = updated;
        return changed;
    }
    if (Array.isArray(sys)) {
        for (const raw of sys) {
            const b = asRecord(raw);
            if (!b) continue;
            const t = typeof b.text === "string" ? b.text : "";
            if (t.startsWith(SENTINEL)) {
                if (t === block) return false;
                b.text = block;
                return true;
            }
        }
        (sys as unknown[]).push({ type: "text", text: block });
        return true;
    }
    return false;
}

function steerOpenAiSystem(obj: Record<string, unknown>, block: string): boolean {
    const msgs = obj.messages;
    if (!Array.isArray(msgs)) return false;
    const arr = msgs as Record<string, unknown>[];
    let target: Record<string, unknown> | null = null;
    for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (m && typeof m === "object" && (m.role === "system" || m.role === "developer")) {
            target = m;
            break;
        }
    }
    if (!target) return false; // skip-if-absent
    const content = target.content;
    if (content === null || content === undefined) {
        target.content = block;
        return true;
    }
    if (typeof content === "string") {
        const [updated, changed] = replaceOrAppend(content, block);
        if (changed) target.content = updated;
        return changed;
    }
    if (Array.isArray(content)) {
        for (const raw of content) {
            const b = asRecord(raw);
            if (!b) continue;
            if (b.type === "text" && typeof b.text === "string" && b.text.startsWith(SENTINEL)) {
                if (b.text === block) return false;
                b.text = block;
                return true;
            }
        }
        (content as unknown[]).push({ type: "text", text: block });
        return true;
    }
    return false;
}

function steerResponsesInstructions(obj: Record<string, unknown>, block: string): boolean {
    const ins = obj.instructions;
    if (ins === undefined) return false; // skip-if-absent
    if (typeof ins !== "string") return false;
    const [updated, changed] = replaceOrAppend(ins, block);
    if (changed) obj.instructions = updated;
    return changed;
}

function steerGoogleSystem(obj: Record<string, unknown>, block: string): boolean {
    const si = asRecord(obj.systemInstruction);
    if (!si) return false; // skip-if-absent
    const parts = si.parts;
    if (!Array.isArray(parts)) return false;
    for (const raw of parts) {
        const p = asRecord(raw);
        if (!p) continue;
        const t = typeof p.text === "string" ? p.text : "";
        if (t.startsWith(SENTINEL)) {
            if (t === block) return false;
            p.text = block;
            return true;
        }
    }
    (parts as unknown[]).push({ text: block });
    return true;
}

// ---- Effort routing (clamp-only; never inject, never toggle thinking.type) ----

/** Documented API floor for Anthropic extended-thinking budget_tokens. */
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
/** Assumed Gemini thinkingBudget floor; verify per-model before relying on it. */
const GOOGLE_MIN_THINKING_BUDGET = 128;

function lowerEffort(obj: Record<string, unknown>, protocol: WireProtocol): boolean {
    switch (protocol) {
        case "openai": {
            const v = clampEffortToFloor(obj.reasoning_effort, "low");
            if (v !== null) {
                obj.reasoning_effort = v;
                return true;
            }
            return false;
        }
        case "responses": {
            const r = asRecord(obj.reasoning);
            if (!r) return false;
            const v = clampEffortToFloor(r.effort, "low");
            if (v !== null) {
                r.effort = v;
                return true;
            }
            return false;
        }
        case "anthropic": {
            let changed = false;
            const oc = asRecord(obj.output_config);
            if (oc) {
                const v = clampEffortToFloor(oc.effort, "low");
                if (v !== null) {
                    oc.effort = v;
                    changed = true;
                }
            }
            const th = asRecord(obj.thinking);
            if (th && typeof th.budget_tokens === "number" && th.budget_tokens > ANTHROPIC_MIN_THINKING_BUDGET) {
                th.budget_tokens = ANTHROPIC_MIN_THINKING_BUDGET;
                changed = true;
            }
            return changed;
        }
        case "google": {
            const gc = asRecord(obj.generationConfig);
            const tc = gc ? asRecord(gc.thinkingConfig) : null;
            // -1 (dynamic) and values at/below the floor are left untouched.
            if (tc && typeof tc.thinkingBudget === "number" && tc.thinkingBudget > GOOGLE_MIN_THINKING_BUDGET) {
                tc.thinkingBudget = GOOGLE_MIN_THINKING_BUDGET;
                return true;
            }
            return false;
        }
    }
}

// ---- Entry points ----

/** Fallback wire detection when the caller has no resolved protocol (e.g. a
 *  passthrough forward where `prepared` is null): infer from the body shape. */
function detectProtocolFromBody(obj: Record<string, unknown>): WireProtocol | null {
    if (Array.isArray(obj.input)) return "responses";
    if (Array.isArray(obj.contents)) return "google";
    if (Array.isArray(obj.messages)) {
        // anthropic carries a top-level `system`; openai chat keeps it in messages
        return obj.system !== undefined ? "anthropic" : "openai";
    }
    return null;
}

interface SteeringResult {
    body: string;
    changed: boolean;
    labels: string[];
}

/** Apply both levers to a serialized wire body. Returns the original string
 *  unchanged (no re-stringify) when nothing was mutated, so the default path
 *  stays byte-identical. Idempotent — safe to re-run on retry re-sends. */
export function applyOutputSteering(body: string, protocol: WireProtocol | null, cfg: OutputSteeringConfig): SteeringResult {
    if (!cfg.enabled) return { body, changed: false, labels: [] };
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return { body, changed: false, labels: [] };
    }
    const proto = protocol ?? detectProtocolFromBody(obj);
    if (!proto) return { body, changed: false, labels: [] };
    const labels = applyOutputSteeringJson(obj, proto, cfg);
    if (labels.length === 0) return { body, changed: false, labels: [] };
    return { body: JSON.stringify(obj), changed: true, labels };
}

/** Object-level variant shared by the forward boundary and the compress-retry
 *  re-send paths. Mutates `parsed` in place; returns the applied labels. */
interface ApplySteeringOptions {
    /** Skip the verbosity directive while keeping effort routing. Reserved for
     *  summarize-shaped requests should they ever route through here: the L2/L3
     *  directive ("never restate code, file contents, diffs, or tool output …")
     *  directly contradicts a compress prompt's own contract — summaries must
     *  preserve exact paths, values and commands verbatim because they are the
     *  primary carrier on decompress. Today's preflight summarize path
     *  (src/preflight.ts summaryPayload) bypasses steering entirely, so no
     *  current call site passes this. */
    verbosity?: boolean;
}

export function applyOutputSteeringJson(parsed: Record<string, unknown>, protocol: WireProtocol | null, cfg: OutputSteeringConfig, opts: ApplySteeringOptions = {}): string[] {
    if (!cfg.enabled) return [];
    const proto = protocol ?? detectProtocolFromBody(parsed);
    if (!proto) return [];
    const decision = decideOutputSteering(toStructural(proto, parsed), cfg);
    const labels: string[] = [];
    if (opts.verbosity !== false && decision.verbosityLevel > 0 && steerSystemPrompt(parsed, proto, decision.verbosityLevel)) {
        labels.push(`steering:L${decision.verbosityLevel}`);
    }
    if (decision.lowerEffort && lowerEffort(parsed, proto)) {
        labels.push("effort:low");
    }
    return labels;
}
