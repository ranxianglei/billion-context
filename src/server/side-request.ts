import type { WireProtocol } from "../util.js";
import { estimateRawBodyTokens } from "../preflight.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { reserveOutputHeadroom, shouldReserveOutputHeadroom } from "../util.js";
import { type ResolvedImageBilling } from "../image-tokens.js";
import { ACP_TOOL_NAMES, ABSORB_TOOL_NAME, IMAGE_FULL_TOOL_NAME, RETRIEVE_TOOL_NAME, RULE_TOOL_NAME } from "acp-kernel";

// #388: side requests (title-gen etc.) share the main session key but must not
// touch kernel state. Identified by a tiny output budget (same heuristic as
// prepareOpenai's isTitleGen); a missing/non-positive budget is never a side req.
// #546: a non-empty tools array marks an agent MAIN turn — clients that size the
// output budget from their raw (uncompressed) history shrink max_tokens to
// <=200 on long sessions; that must never demote the request to a side pass
// (title-gen requests never carry tools).
// #1699: explicit host intent outranks the budget heuristic. opencode v2 sends
// title-gen WITHOUT max_tokens (options {} for kind==="title"), so the budget
// path below can never see it; the host stamps its persona id
// (x-bili-plugin-agent) and a known side-request agent is a side req by
// definition regardless of budget.
export const SIDE_REQUEST_MAX_TOKENS = 200;
// Persona ids whose requests are side requests by intent (#1699). Main personas
// (build/plan/general/...) are deliberately absent — they are real turns.
export const SIDE_REQUEST_AGENTS: ReadonlySet<string> = new Set(["title"]);
export function isSideRequest(parsed: unknown, requestAgent?: string): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    if (requestAgent !== undefined && SIDE_REQUEST_AGENTS.has(requestAgent)) return true;
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    const field = outputBudgetField(parsed);
    if (!field) return false;
    const raw = readOutputBudget(p, field);
    return typeof raw === "number" && raw > 0 && raw <= SIDE_REQUEST_MAX_TOKENS;
}

// #1897: hosts like omp register bili's ACP tools as first-class extension tools
// and include them in EVERY model request — including side requests (title-gen),
// which carry no host action tools of their own. The title request defeats both
// existing signals at once: omp titles with max_tokens=1024 (> the budget gate)
// AND the leaked bili tools make the #546 "non-empty tools = main turn" rule fire,
// so the title payload rides processTurn under the main session id (refs/usage
// pollution + ~4K of billed tool tokens per session start). Structural signal: a
// request whose ENTIRE tools array is bili's own context-management set has no
// action surface — it is a side request with leaked bili tools, not an agent turn
// (an agent turn needs a world to act in). Renamed opt-in tools (absorb.toolName
// / ccr.toolName) stay out of the set on purpose: only the kernel-fixed names are
// guaranteed bili-owned, and any host tool vetoes the demotion.
export const BILI_TOOL_NAMES: ReadonlySet<string> = new Set([
    ...ACP_TOOL_NAMES,
    ABSORB_TOOL_NAME,
    RULE_TOOL_NAME,
    RETRIEVE_TOOL_NAME,
    IMAGE_FULL_TOOL_NAME,
]);

/** Tool names declared by `parsed.tools`, proto-agnostically. null when the
 *  array is absent/empty or any entry is unparseable (a veto, not an error):
 *  openai `{type:"function",function:{name}}`, responses/anthropic `{name}`,
 *  google `{functionDeclarations:[{name}]}` (one entry may declare many). */
function biliToolNamesIn(parsed: Record<string, unknown>): string[] | null {
    const tools = parsed.tools;
    if (!Array.isArray(tools) || tools.length === 0) return null;
    const names: string[] = [];
    for (const t of tools) {
        if (!t || typeof t !== "object") return null;
        const o = t as Record<string, unknown>;
        const decls = o.functionDeclarations;
        if (Array.isArray(decls)) {
            for (const d of decls) {
                if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).name !== "string") return null;
                names.push((d as Record<string, unknown>).name as string);
            }
            continue;
        }
        let name = o.name;
        if (typeof name !== "string") {
            const fn = o.function;
            if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") name = (fn as Record<string, unknown>).name;
        }
        if (typeof name !== "string") return null;
        names.push(name);
    }
    return names;
}

/** #1897: true when `parsed` carries ONLY bili's own tools (no host action
 *  surface) — the caller must route the request through the side passthrough.
 *  On a match the leaked `tools` key is deleted, restoring the pre-bili wire
 *  shape upstream expects for a tool-less utility call. Any host tool,
 *  unparseable entry, or missing/empty tools leaves the body untouched. A
 *  STARVED output budget (<= SIDE_REQUEST_MAX_TOKENS) also vetoes: per #546 a
 *  starved tool-carrying request is the death-spiral rescue path —
 *  restoreOutputBudget must run so the model regains the output room to emit
 *  compress — so such requests stay main turns even when every tool is bili's. */
export function stripLeakedBiliTools(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const p = parsed as Record<string, unknown>;
    const names = biliToolNamesIn(p);
    if (names === null || !names.every((n) => BILI_TOOL_NAMES.has(n))) return false;
    const field = outputBudgetField(p);
    if (field) {
        const raw = readOutputBudget(p, field);
        if (typeof raw === "number" && raw > 0 && raw <= SIDE_REQUEST_MAX_TOKENS) return false;
    }
    delete p.tools;
    return true;
}

export type OutputBudgetField = "max_tokens" | "max_completion_tokens" | "max_output_tokens" | "generationConfig.maxOutputTokens";

/** The declared output budget, proto-agnostically. Gemini nests it under
 *  `generationConfig` (the dotted field name above), the OpenAI/Anthropic
 *  families keep it flat, so every reader goes through these two accessors. */
export function outputBudgetField(parsed: unknown): OutputBudgetField | null {
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
        if (typeof p[field] === "number" && (p[field] as number) > 0) return field;
    }
    const gen = p.generationConfig;
    if (gen && typeof gen === "object") {
        const v = (gen as Record<string, unknown>).maxOutputTokens;
        if (typeof v === "number" && v > 0) return "generationConfig.maxOutputTokens";
    }
    return null;
}

export function readOutputBudget(parsed: Record<string, unknown>, field: OutputBudgetField): number | undefined {
    if (field !== "generationConfig.maxOutputTokens") {
        const v = parsed[field];
        return typeof v === "number" ? v : undefined;
    }
    const gen = parsed.generationConfig;
    if (!gen || typeof gen !== "object") return undefined;
    const v = (gen as Record<string, unknown>).maxOutputTokens;
    return typeof v === "number" ? v : undefined;
}

export function writeOutputBudget(parsed: Record<string, unknown>, field: OutputBudgetField, value: number): void {
    // #2011: output-budget fields are integer-typed on every wire protocol. Coerce at this
    // sole writer so NO caller can emit a fractional token count — the clamp path already
    // floors, but this also guards the restore path and any future caller at the type boundary.
    const tokens = Number.isInteger(value) ? value : Math.floor(value);
    if (field !== "generationConfig.maxOutputTokens") {
        parsed[field] = tokens;
        return;
    }
    const gen = parsed.generationConfig;
    parsed.generationConfig = { ...(gen && typeof gen === "object" ? (gen as Record<string, unknown>) : {}), maxOutputTokens: tokens };
}

// #1840: one-shot "restore has no ceiling" warnings, keyed by MODEL (the fact
// is model-scoped — any session hitting the same ceiling-less model repeats
// the same silent degradation). Capped like warnedNoModelRequests: an unbounded
// set would grow one entry per dead model id on long-running daemons.
const warnedNoOutputCeiling = new Set<string>();
const WARNED_NO_OUTPUT_CEILING_CAP = 4096;
function noteNoOutputCeilingWarning(model: string): boolean {
    if (warnedNoOutputCeiling.has(model)) return false;
    if (warnedNoOutputCeiling.size >= WARNED_NO_OUTPUT_CEILING_CAP) warnedNoOutputCeiling.clear();
    warnedNoOutputCeiling.add(model);
    return true;
}
export function _resetNoOutputCeilingWarningsForTest(): void {
    warnedNoOutputCeiling.clear();
}

/** #546: clients that derive the output budget from their RAW (uncompressed)
 *  history drive it down to <=200 tokens on long sessions, then truncate every
 *  reply mid-thought — the model cannot even emit a compress tool call, so the
 *  loop can never rescue the session. The proxy's compressed view still fits
 *  the window, so remember the healthy budget per session (last non-starved
 *  value wins) and restore it on tool-carrying main requests whose budget has
 *  starved. Mutates `parsed` in place BEFORE prepare() serializes it.
 *  #1665/#1840: the remembered water mark can itself be pathologically low — a
 *  client that sizes its budget from RAW history decays through small positive
 *  values (…, 680, 234) before starving at <=200, so "last non-starved wins"
 *  ends holding a death rattle; a session first opened into bili with an
 *  already-oversized history never seeds anything at all. Floor the restore
 *  target at the best-known OUTPUT ceiling for the model (`outputCeiling`,
 *  resolved by the caller through the same source chain as the output-headroom
 *  fallback — #1840 widened the #1665 operator-declared-only floor to
 *  runtime-info / launcher / registry sources) so a broken client cannot pin
 *  the session at a few hundred tokens forever. The #453 clamp downstream
 *  still bounds the result by real window headroom. A ceiling at/below the
 *  side-request threshold is not usable; a healthy water mark above the
 *  ceiling keeps winning (it is a capability floor, not an instruction cap).
 *  When NO source knows a ceiling, warn once per model: the restore is backed
 *  only by the client's own last non-starved value, which is exactly the
 *  silent-degradation path this issue reports. */
export function restoreOutputBudget(
    parsed: unknown,
    session: { id: string; metadata: Record<string, unknown> },
    log: (level: string, msg: string) => void,
    outputCeiling?: number,
): void {
    const field = outputBudgetField(parsed);
    if (!field) return;
    const p = parsed as Record<string, unknown>;
    const value = readOutputBudget(p, field);
    if (value === undefined) return;
    if (value > SIDE_REQUEST_MAX_TOKENS) {
        session.metadata.outputBudgetHighWater = value;
        return;
    }
    if (!Array.isArray(p.tools) || p.tools.length === 0) return;
    const highWaterRaw = session.metadata.outputBudgetHighWater;
    const highWater = typeof highWaterRaw === "number" && highWaterRaw > SIDE_REQUEST_MAX_TOKENS ? highWaterRaw : undefined;
    let target = highWater;
    const ceiling = typeof outputCeiling === "number" && outputCeiling > SIDE_REQUEST_MAX_TOKENS ? outputCeiling : undefined;
    if (ceiling !== undefined && (target === undefined || ceiling > target)) target = ceiling;
    const modelName = typeof p.model === "string" && p.model.length > 0 ? p.model : "?";
    if (typeof target === "number") {
        writeOutputBudget(p, field, target);
        const note = target === ceiling && ceiling !== undefined
            ? (highWater === undefined ? "; no healthy high-water yet — using known output ceiling (#1665/#1840)" : `; high-water ${highWater} below known output ceiling — floored (#1665/#1840)`)
            : "";
        log("info", `[${session.id}] output budget restored ${value} -> ${target} (#546: client shrank it from its raw-history estimate${note})`);
    }
    if (ceiling === undefined && noteNoOutputCeilingWarning(modelName)) {
        log("warn", `[${session.id}] output-budget restore has NO known output ceiling for model=${modelName}${typeof target === "number" ? ` (restored ${value} -> ${target})` : ` (starved budget ${value} forwarded verbatim)`} — the target is the client's own last non-starved budget; while it stays pathologically small every turn truncates at max-tokens. Declare the model's max output in the bili config (providers.<url>.models."${modelName}".output) or have the client report it to floor the restore (#1840)`);
    }
}

// defaultCountTokens counts CJK per-char but real tokenizers encode CJK at
// ~0.6-0.75 tokens/char, so CJK-heavy raw bodies over-estimate by up to ~1.6x.
// Everywhere else that bias is safe (it only compresses earlier); here it
// would hard-deny a payload that really fits (retryable: false), so tolerate
// 15% over the window — borderline payloads forward, and a real overflow 400
// still teaches the learned limit.
const SIDE_REQUEST_GUARD_TOLERANCE = 1.15;

/** #554: side requests are forwarded VERBATIM (no pipeline, #388), so a payload
 *  over the upstream window is a guaranteed 400 that preflight can never fix
 *  from this path. Block here instead of forwarding: estimate the RAW body
 *  (CJK-aware text + image tokens) against the effective window — the declared
 *  modelContextLimit (#987: no learned window exists anymore) minus the output
 *  reservation on wires where output counts against the window. blocked=false
 *  with limit<=0 means "window unknown — forward as before". blocked requires
 *  estimate >= limit x SIDE_REQUEST_GUARD_TOLERANCE (estimator bias). */
export function sideRequestGuard(
    parsed: unknown,
    protocol: WireProtocol,
    modelContextLimit: number,
    imageBilling: ResolvedImageBilling = "bytes",
    configuredCap?: number,
    headroomCap: number = 1,
    armedLimit: number = 0,
    /** #1843 L1: pre-resolved image reserve (learned truth when fresh, else the
     *  prior) — replaces the internal billing-based estimate when provided so
     *  the guard sees the same image channel every other gate consumes. */
    imageReserve?: number,
): { blocked: boolean; estimate: number; limit: number } {
    let limit = modelContextLimit;
    // #987: no learned window exists, but a usage-grounded arm left by an
    // overflow 400 (the upstream STATED that size) is live evidence this
    // session cannot exceed it — a side request above it is the same
    // guaranteed 400 (#554 loop). The arm is one-shot memory (a successful
    // turn's usage overwrites it); it never re-centers the declared window.
    if (armedLimit > 0 && (limit <= 0 || armedLimit < limit)) limit = armedLimit;
    const field = outputBudgetField(parsed);
    const maxOut = (field ? readOutputBudget(parsed as Record<string, unknown>, field) : undefined) ?? 0;
    if (limit > 0 && shouldReserveOutputHeadroom(protocol)) limit = reserveOutputHeadroom(limit, maxOut, headroomCap);
    const imageMass = imageReserve ?? imageTokensInParsedBody(protocol, parsed, imageBilling, configuredCap);
    const estimate = estimateRawBodyTokens(parsed) + imageMass;
    return { blocked: limit > 0 && estimate >= limit * SIDE_REQUEST_GUARD_TOLERANCE, estimate, limit };
}
