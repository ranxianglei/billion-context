import type { WireProtocol } from "../util.js";
import { estimateRawBodyTokens } from "../preflight.js";
import { imageTokensInParsedBody } from "../image-tokens.js";
import { reserveOutputHeadroom, systemCarrierTexts } from "../util.js";
import { type ResolvedImageBilling } from "../image-tokens.js";
import { ACP_TOOL_NAMES, ABSORB_TOOL_NAME, RETRIEVE_TOOL_NAME, RULE_TOOL_NAME } from "acp-kernel";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "../compress-tool.js";

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

// #2500: Anthropic server-executed tool types are versioned by date and the
// client NEVER executes them — a request whose ENTIRE tool surface is these
// types is a host-internal utility call (Claude Code's WebSearch sub-request,
// sent under the main session id), not an agent turn. The dated suffix is
// load-bearing: client-executed versioned tools (bash_20250124, text_editor_*,
// computer_*) must keep their sessions on the main pipeline, and unversioned
// client tools carry no matching type at all.
const SERVER_EXECUTED_TOOL_TYPES = /^(?:web_search|web_fetch)_\d{8}$/;

/** #2500: structural identification of a server-tool-only utility call.
 *  Decisive conditions (all must hold):
 *   - exactly ONE message (a forced-search turn replaying conversation history
 *     is a real main turn — the model may be asked to search mid-conversation);
 *   - non-empty tools where EVERY entry's type matches a server-executed
 *     web_search_/web_fetch_ version — mixing ANY client-side tool (including
 *     leaked bili tools) vetoes;
 *   - tool_choice absent or auto/any (string or object form); forcing
 *     {type:"tool",name} is allowed only for a DECLARED tool (Claude Code's
 *     thinking-off source shape forces {type:"tool",name:"web_search"});
 *     "none" or any unrecognized shape vetoes.
 *  Deliberately proto-safe by shape alone: OpenAI entries are type "function",
 *  the Responses wire uses `input` and unversioned types, Google uses
 *  functionDeclarations — none can match. */
export function isServerToolUtilityCall(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    const messages = p.messages;
    if (!Array.isArray(messages) || messages.length !== 1) return false;
    const tools = p.tools;
    if (!Array.isArray(tools) || tools.length === 0) return false;
    const declared = new Set<string>();
    for (const t of tools) {
        if (t === null || typeof t !== "object") return false;
        const type = (t as { type?: unknown }).type;
        if (typeof type !== "string" || !SERVER_EXECUTED_TOOL_TYPES.test(type)) return false;
        const name = (t as { name?: unknown }).name;
        if (typeof name === "string" && name.length > 0) declared.add(name);
    }
    const choice = p.tool_choice;
    if (choice === undefined) return true;
    if (choice === "auto" || choice === "any") return true;
    if (choice !== null && typeof choice === "object") {
        const c = choice as { type?: unknown; name?: unknown };
        if (c.type === "auto" || c.type === "any") return true;
        if (c.type === "tool" && typeof c.name === "string" && declared.has(c.name)) return true;
    }
    return false;
}

export function isSideRequest(parsed: unknown, requestAgent?: string): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    if (requestAgent !== undefined && SIDE_REQUEST_AGENTS.has(requestAgent)) return true;
    if (requestAgent === "main") return false;
    const p = parsed as Record<string, unknown>;
    // #2500: BEFORE the #546 rule — a server-tool-only utility call carries
    // non-empty tools but is not an agent turn. Routed through the #388 side
    // passthrough so its usage (often far above its own tiny context) can
    // never re-anchor the main session's nudge baseline (#1595) and nothing
    // gets injected into it. Explicit host intent above still outranks this.
    if (isServerToolUtilityCall(p)) return true;
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    const field = outputBudgetField(parsed);
    if (!field) return false;
    const raw = readOutputBudget(p, field);
    return typeof raw === "number" && raw > 0 && raw <= SIDE_REQUEST_MAX_TOKENS;
}

// #2503: dsh's title-gen sidecar stamps no persona header, and its output
// budget is host-sized, not bili-sized: dsh 0.2.1-alpha.2 raised the base
// bundle preset maxOutputTokens 64 -> 4096 ("a ceiling against runaway
// output" — reasoning tokens count), so the <=200 heuristic above now misses
// it: the title request looks like a main turn and, under the #1916 dsh
// persona fingerprint, forks onto a persisted |sub:<fp> ghost session instead
// of riding the #388 verbatim passthrough (e2e scenario A / #2241 fails).
// Match on the fixed first line of dsh's title system prompt (stable on the
// wire across rc.2/alpha.2; dsh-session-title-first-prompt-llm). The same
// no-tools veto as isSideRequest keeps any future main turn out of this path.
// The caller must gate on x-bili-plugin=dsh (evidence-per-client discipline,
// cf. dshPersonaFingerprintApplies in src/session-id.ts).
export const DSH_TITLE_SYSTEM_PREFIX = "Create a concise title for an AI coding-assistant session";

// #3149: on the anthropic wire the title prompt rides the TOP-LEVEL `system`
// field while messages[] holds only the user blob; reading messages[] alone
// (#2503) let the sidecar claim the raw anchor and fork the real conversation
// onto a |sub:<fp> ghost. systemCarrierTexts (src/util.ts) reads every wire.
export function isDshTitleRequest(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    return systemCarrierTexts(p).some((t) => t.startsWith(DSH_TITLE_SYSTEM_PREFIX));
}

// #4438: dsh's auto-review sidecar (@deepseek-ai/dsh-experimental-auto-review's
// classifyRisk()) fires before every native tool call under the Auto permission
// tier: a fixed REVIEW_POLICY system prompt + exactly ONE freshly-flattened user
// blob (ENVIRONMENT / PROJECT_INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION),
// no tools, same conversation id as the main turn. On at least one deployment
// class (web profile behind a gateway) the extension's own model client reaches
// bili UNSTAMPED — no x-bili-plugin — while the session's sticky plugin binding
// keeps the #2432 rebase gate armed for it: every header-gated isolation gate
// (persona fork #1916, title clause #2503) misses the request, the blob rides
// the raw main key through the FULL pipeline, its embedded old-checkpoint
// framing false-positives the local-compaction carrier (#2621 class, total fold
// state wipe), and its usage sample clobbers the main baseline so the next turn
// skips the output clamp (#453) into permanent upstream 400s.
// Shape-decisive WITHOUT a caller-side header gate — deliberately different from
// isDshTitleRequest's discipline: the shape carries its own client evidence
// (dsh's fixed REVIEW_POLICY first line, version-pinned like
// DSH_TITLE_SYSTEM_PREFIX / DSH_COMPACTION_INSTRUCTION_PREFIX), and the header
// gate is precisely what failed here. A main turn can never match: it carries a
// tools surface and multi-turn history; the single-blob bar rejects every
// history-replaying request.
export const DSH_AUTO_REVIEW_SYSTEM_PREFIX = "You are the final authorization reviewer for exactly one pending tool call";

export function isDshAutoReviewRequest(protocol: string | null, parsed: unknown): boolean {
    if (protocol === null || !parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    // Same no-tools veto as isSideRequest/isDshTitleRequest: any action surface
    // marks an agent turn, not the reviewer's one-shot call.
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    // The fixed reviewer policy on ANY wire's system carrier (top-level system,
    // instructions, systemInstruction.parts, or a role:system entry in
    // messages[]/input[]) — systemCarrierTexts reads them all (#3149 lesson).
    if (!systemCarrierTexts(p).some((t) => t.trimStart().startsWith(DSH_AUTO_REVIEW_SYSTEM_PREFIX))) return false;
    const entries = protocol === "responses" ? p.input : protocol === "google" ? p.contents : p.messages;
    if (!Array.isArray(entries)) return false;
    let users = 0;
    let userHasContent = false;
    for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        const role = rec.role;
        if (role === "system" || role === "developer") continue;
        // Responses-side typed items that are not plain messages (reasoning,
        // function_call, …) can only appear in a real model round-trip.
        if (role !== "user") return false;
        if (rec.type !== undefined && rec.type !== "message") return false;
        users += 1;
        const c = rec.content ?? rec.parts;
        if (typeof c === "string") {
            if (c.length > 0) userHasContent = true;
        } else if (Array.isArray(c) && c.length > 0) {
            userHasContent = true;
        }
    }
    // Exactly ONE non-system message with content: the freshly-flattened review
    // snapshot. A replayed history (any assistant/tool turn or a second user
    // message) vetoes — see the comment above the constant.
    return users === 1 && userHasContent;
}

// #5135: Claude Code's session-title sidecar (terminal CLI, proxy mode — no
// x-bili-plugin stamp). It fires at session start UNDER THE SAME
// x-claude-code-session-id as the first main turn, ~1ms ahead of it. Field
// shape (0.1.209, three machines): a single user message wrapping the first
// prompt in \x3csession\x3e…\x3c/session\x3e, no tools, an output budget past
// the <=200 heuristic, and its OWN system prompt — so pre-fix it entered the
// #4774 order resolver on the virgin id and CLAIMED the raw key as kernel
// anchor; the main turn then arrived tagChanged and history-disjoint and
// forked onto a |sub:<fp> lane for the session lifetime (#2156 form: side
// requests must never claim the anchor). A main turn can never match: it
// carries a tools surface and multi-turn history; the one-entry bar rejects
// every history-replaying request. The caller must gate on
// claudeAnthropicPersonaOrderApplies (evidence-per-client discipline): the
// wrapper alone is not client proof.
export const CLAUDE_CODE_TITLE_SESSION_TAG = "\x3csession\x3e";

export function isClaudeCodeTitleRequest(protocol: string | null, parsed: unknown): boolean {
    if (protocol === null || !parsed || typeof parsed !== "object") return false;
    const p = parsed as Record<string, unknown>;
    // Same no-tools veto as isSideRequest/isDshTitleRequest/isDshAutoReviewRequest.
    if (Array.isArray(p.tools) && p.tools.length > 0) return false;
    const entries = protocol === "responses" ? p.input : protocol === "google" ? p.contents : p.messages;
    // Exactly ONE entry total: on the anthropic wire the system rides top-level,
    // so any extra messages[] row (a role:system entry included) is a replayed
    // history, not the one-shot title call.
    if (!Array.isArray(entries) || entries.length !== 1) return false;
    const entry = entries[0];
    if (entry === null || typeof entry !== "object") return false;
    const rec = entry as Record<string, unknown>;
    if (rec.role !== "user") return false;
    if (rec.type !== undefined && rec.type !== "message") return false;
    const c = rec.content ?? rec.parts;
    let text = "";
    if (typeof c === "string") {
        text = c;
    } else if (Array.isArray(c)) {
        for (const b of c) {
            if (b !== null && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
                text += (b as Record<string, unknown>).text as string;
            }
        }
    }
    return text.trimStart().startsWith(CLAUDE_CODE_TITLE_SESSION_TAG);
}

// #2170 measure 1: the two lane gates extracted from src/server.ts so they have
// ONE home and an exhaustive truth-table test. They are PURE — the two effects
// that guard demotion (detectAcpArtifacts' full-history re-encode and the
// stripLeakedBiliTools mutation) stay in the caller and MUST stay lazily
// evaluated after demoteGate (never hoisted — see the sideRequestLike note in
// src/server.ts: the artifact scan may only run for the all-bili subset).
export interface DemoteGateSignals {
    countTokens: boolean;
    responsesCompact: boolean;
    protocol: WireProtocol | null;
    pluginMode: boolean;
    requestAgent: string | undefined;
    wsLaneEnvelope: boolean;
    publicForkPrefix: boolean;
}
// Heuristic demotion eligibility — every conjunct is cheap (no request-body
// scan). `publicForkPrefix` deliberately vetoes: a public-fork child's EARLY
// mainline turns (raw inherited prefix, no artifacts yet, no agent header)
// false-positive the leak-shape heuristic; once anchored, the fork's side
// requests enter the lane via `sideIntent` instead (which resolves without
// any fork input — the #2164 fix).
export function demoteGate(s: DemoteGateSignals): boolean {
    return !s.countTokens && !s.responsesCompact && s.protocol !== null && s.pluginMode
        && s.requestAgent !== "main" && !s.wsLaneEnvelope && !s.publicForkPrefix;
}

export interface SideLaneSignals {
    countTokens: boolean;
    responsesCompact: boolean;
    protocol: WireProtocol | null;
    // stripLeakedBiliTools() ran and stripped (only ever true when demoteGate
    // held and detectAcpArtifacts returned null — the caller's short-circuit).
    stripApplied: boolean;
    sideIntent: boolean;
    requestAgent: string | undefined;
    // #2500: caller-supplied label for a structurally identified side request
    // (the max_tokens<=200 fallback string below cannot describe it).
    sideLabel?: string;
}
export type SideLaneDecision = { lane: "side" | "main"; demoted: boolean; reason: string };
// The #388 lane decision. `demoted` ⊆ `lane === "side"`. No fork input can
// reach here: intent-certain side requests ride the lane under a fork receipt
// (#2164) — that property is structural (there is no fork field to consult).
export function resolveSideLane(s: SideLaneSignals): SideLaneDecision {
    if (s.countTokens || s.responsesCompact || s.protocol === null) {
        return { lane: "main", demoted: false, reason: "not a model turn" };
    }
    if (s.stripApplied) {
        return { lane: "side", demoted: true, reason: "leaked bili tools stripped (#1897)" };
    }
    if (s.sideIntent) {
        const reason = s.sideLabel ?? (s.requestAgent !== undefined ? `agent=${s.requestAgent}` : `max_tokens<=${SIDE_REQUEST_MAX_TOKENS}`);
        return { lane: "side", demoted: false, reason };
    }
    return { lane: "main", demoted: false, reason: "main turn" };
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
    READ_ORIGINAL_IMAGE_TOOL_NAME,
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
/** #2156: READ-ONLY structural twin of stripLeakedBiliTools — same verdict,
 *  no mutation. Lets callers (the persona-anchor bypass in server.ts) ask
 *  "would this request be demoted via #1897?" before any decision point that
 *  must not pay the mutation or re-run the check. */
export function hasLeakedBiliToolsOnly(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const p = parsed as Record<string, unknown>;
    const names = biliToolNamesIn(p);
    if (names === null || !names.every((n) => BILI_TOOL_NAMES.has(n))) return false;
    const field = outputBudgetField(p);
    if (field) {
        const raw = readOutputBudget(p, field);
        if (typeof raw === "number" && raw > 0 && raw <= SIDE_REQUEST_MAX_TOKENS) return false;
    }
    return true;
}

export function stripLeakedBiliTools(parsed: unknown): boolean {
    if (!hasLeakedBiliToolsOnly(parsed)) return false;
    delete (parsed as Record<string, unknown>).tools;
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

// #3071: absolute capability floor for the output budget when NO source knows a
// ceiling for the model. The client's raw-history-derived budget decays unbounded
// (…, 3071, 2061, 252, <=200); "last non-starved wins" then pins the session at a
// death rattle with NO lower bound, and a fresh fork child inherits that rattle and
// forwards it verbatim (max_tokens=1 out the door). Floor the forwarded budget at
// this minimum so a ceiling-less model can never truncate every reply below the
// point where the model can even emit a compress call or short visible text. It is
// a LOWER bound only — a healthy client value above it passes through untouched.
// #3406: the floor applies ONLY when the session has no FUNCTIONAL bound of
// its own (born-starved / fork-inherited rattle, or a high-water below
// OUTPUT_HIGH_WATER_TRUST_MIN). A high-water at/above the trust line is the
// session's own proven budget — the healthy branch forwarded it verbatim and the
// provider accepted it at full value — so it is an explicit smaller legal bound:
// raising it to this floor trades a degraded-but-working session for a hard 400
// on any provider whose maxOutputTokens cap sits below 32K.
// Magnitude is 32K, not 8K (#3071 follow-up, owner decision 2026-10-15): a ceiling-less
// model generally sustains >=32K of output, while 8K is consumed by a single modest
// thinking block before any visible text survives, so 8K left the problem unfixed.
// Flat (not window-relative): restoreOutputBudget runs BEFORE the window is resolved
// at its call site, and both the downstream #453 clamp and the output-headroom
// reservation (which self-caps at 25% of window) bound the result by real headroom
// regardless of this floor.
export const OUTPUT_RESTORE_ABSOLUTE_FLOOR = 32768;

// #3406: a recorded high-water is trusted as the restore target (never raised
// to the absolute floor) only when it is a FUNCTIONAL budget — at or above the
// same capability line the #453 downstream clamp already enforces
// (OUTPUT_CLAMP_MIN_OUTPUT, src/server/budget.ts: "capability floor for the
// clamped budget", #3071/#2490) and the same magnitude a real host ships as a
// deliberate preset (dsh bundle 4096, "a ceiling against runaway output"). A
// high-water below it is the observed #3071 death-rattle zone (decay chains
// …, 2061, 252): too small to emit a compress call or visible text, so it is
// NOT treated as a legal bound and the floor still overrides it.
const OUTPUT_HIGH_WATER_TRUST_MIN = 4096;

// #1840/#3071: one-shot "restore has no ceiling" warnings, keyed by SESSION+MODEL.
// #1840 keyed them by MODEL alone, but the degradation is SESSION-scoped: the
// session actually being starved got no warn because another session hit the same
// ceiling-less model first (#3071 path 2a). Keying by session+model gives each
// affected session exactly one WARN naming itself while staying bounded (the cap
// limits the set size, not the turn count).
const warnedNoOutputCeiling = new Set<string>();
const WARNED_NO_OUTPUT_CEILING_CAP = 4096;
function noteNoOutputCeilingWarning(sessionId: string, model: string): boolean {
    const key = `${sessionId}|${model}`;
    if (warnedNoOutputCeiling.has(key)) return false;
    if (warnedNoOutputCeiling.size >= WARNED_NO_OUTPUT_CEILING_CAP) warnedNoOutputCeiling.clear();
    warnedNoOutputCeiling.add(key);
    return true;
}
export function _resetNoOutputCeilingWarningsForTest(): void {
    warnedNoOutputCeiling.clear();
}
function noCeilingWarnText(sessionId: string, model: string, from: number, to: number): string {
    return `[${sessionId}] output-budget restore has NO known output ceiling for model=${model} (raised ${from} -> ${to}) — the target was the client's own raw-history estimate, which decays unbounded; while it stays pathologically small every turn truncates at max-tokens. Declare the model's max output in the bili config (providers.<url>.models."${model}".output) or have the client report it to floor the restore higher (#1840/#3071)`;
}

// #3438: one-shot per SESSION+MODEL warn for the UNRESCUABLE dsh-lane mid-band —
// a tool-carrying budget above the <=200 starve gate with NO known output ceiling
// cannot be told apart from a deliberate cap, so it forwards verbatim; this warn
// gives the previously silent high-water branch observability without spamming.
const warnedDshMidBandNoCeiling = new Set<string>();
function noteDshMidBandNoCeilingWarning(sessionId: string, model: string): boolean {
    const key = `${sessionId}|${model}`;
    if (warnedDshMidBandNoCeiling.has(key)) return false;
    if (warnedDshMidBandNoCeiling.size >= WARNED_NO_OUTPUT_CEILING_CAP) warnedDshMidBandNoCeiling.clear();
    warnedDshMidBandNoCeiling.add(key);
    return true;
}
export function _resetDshMidBandWarningsForTest(): void {
    warnedDshMidBandNoCeiling.clear();
}

// #2904: the no-ceiling degraded state surfaced by the /acp panel, the
// /__bili/plugin/status?conversationId= JSON and the web session page while it holds. #1840's
// once-per-model log warn is invisible to GUI hosts (stderr swallowed), so the
// pinning this issue reports has no user-reachable signal; this record is that
// signal, cleared as soon as a ceiling appears or the client's own estimate
// recovers. Single slot: only the most recently starved ceiling-less model is
// tracked (a session realistically pins on its CURRENT model).
interface OutputBudgetDegradedState { model: string; value: number; ts: number }
function clearNoCeilingDegraded(session: { metadata: Record<string, unknown> }, model: string): void {
    const cur = session.metadata.outputBudgetDegraded as OutputBudgetDegradedState | undefined;
    if (cur !== undefined && cur.model === model) delete session.metadata.outputBudgetDegraded;
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
 *  side-request threshold is not usable; a water mark ABOVE the ceiling no
 *  longer wins (#3833): it is a stale cross-model artifact — the restore is
 *  clamped down to the ceiling and the over-bound water corrected in place.
 *  #3071/#3406: when NO source knows a ceiling, a starved request is floored
 *  at OUTPUT_RESTORE_ABSOLUTE_FLOOR unless the session's recorded high-water is
 *  a functional budget (>= OUTPUT_HIGH_WATER_TRUST_MIN) — a fresh/forked
 *  session with no high-water and a decayed death-rattle high-water both keep
 *  the floor (#3071), while a proven working high-water is restored to AS-IS
 *  and never raised above (#3406): it is the budget the provider already
 *  accepted at full value, and raising it to the 32K floor hard-rejects on
 *  providers that cap maxOutputTokens below 32K (availability over ideology,
 *  #3128). A non-starved value is always trusted and recorded verbatim as the
 *  high-water. The no-ceiling condition warns once per SESSION+model (the
 *  degradation is session-scoped).
 *  #3438: on lanes whose host stamps the model-declared maxTokens onto every
 *  main turn by contract (`dshLane` — the dsh host's pi-ai buildBaseOptions
 *  default), a tool-carrying budget BELOW the known ceiling is a raw-history
 *  collapse, not intent: the client's estimator sees zero real usage on
 *  replayed history and falls back to chars/4 over the unfolded history, which
 *  shrinks toward zero as the raw history approaches the window. Such mid-band
 *  values (above the <=200 starve gate) are treated as starved too — restored
 *  through the same target logic — and are NEVER recorded as the high-water
 *  (they are collapse evidence, not proven health). With NO known ceiling the
 *  lane cannot judge collapse from intent: the value forwards verbatim but
 *  warns once per SESSION+model so the operator can declare the model's output
 *  cap to arm the rescue. Non-dsh lanes keep the old behavior byte-exact — a
 *  deliberately small budget elsewhere is intent, not collapse. */
export function restoreOutputBudget(
    parsed: unknown,
    session: { id: string; metadata: Record<string, unknown> },
    log: (level: string, msg: string) => void,
    outputCeiling?: number,
    /** #3438: true when this lane's host stamps the model-declared maxTokens onto every main turn by contract (dsh/pi-ai buildBaseOptions default) — see the doc above. */
    dshLane?: boolean,
): void {
    const field = outputBudgetField(parsed);
    if (!field) return;
    const p = parsed as Record<string, unknown>;
    const value = readOutputBudget(p, field);
    if (value === undefined) return;
    const modelName = typeof p.model === "string" && p.model.length > 0 ? p.model : "?";
    // A usable ceiling is known from some source (runtime-info / launcher /
    // configured route / registry); a value at/below the side threshold is not usable.
    const ceiling = typeof outputCeiling === "number" && outputCeiling > SIDE_REQUEST_MAX_TOKENS ? outputCeiling : undefined;
    // #3438: on the dsh lane a below-ceiling tool-carrying budget IS the collapse
    // signature (see the doc above) — it must not pass through as "healthy", and
    // it must not seed the high-water as if it were proven health.
    const collapsed = dshLane === true && ceiling !== undefined && value < ceiling;
    if (value > SIDE_REQUEST_MAX_TOKENS && !collapsed) {
        session.metadata.outputBudgetHighWater = value;
        // #2904: a healthy (non-starved) budget means the client's own estimate
        // recovered — the active no-ceiling pin for THIS model is gone, so drop
        // its marker (other models' markers are untouched).
        clearNoCeilingDegraded(session, modelName);
        // #3438: dsh-lane mid-band with NO known ceiling — bili cannot judge
        // collapse from intent here, so forward verbatim but surface the gap once.
        if (dshLane === true && ceiling === undefined && Array.isArray(p.tools) && p.tools.length > 0 && noteDshMidBandNoCeilingWarning(session.id, modelName)) {
            log("warn", `[${session.id}] dsh-lane main request carries output budget ${value} with NO known output ceiling for model=${modelName} — cannot tell a raw-history collapse from deliberate intent, forwarding verbatim; declare the model's max output (providers.<url>.models."${modelName}".output) to arm the mid-band collapse rescue (#3438)`);
        }
        return;
    }
    // Starved or #3438-collapsed main request (budget + tools present). A side
    // request (no tools) never reaches here — restoring it would break its side status.
    if (!Array.isArray(p.tools) || p.tools.length === 0) return;
    const highWaterRaw = session.metadata.outputBudgetHighWater;
    const highWater = typeof highWaterRaw === "number" && highWaterRaw > SIDE_REQUEST_MAX_TOKENS ? highWaterRaw : undefined;
    let target = highWater;
    if (ceiling !== undefined) {
        // #3833: the ceiling is a HARD upstream bound on this model's output
        // (glm-5.3 rejects max_tokens above 131072 with 400 code 1210). A
        // cross-model high-water learned from a previous model whose declared
        // ceiling was higher must NOT be restored verbatim into this model's
        // request — clamp the restore target down to the ceiling and correct the
        // over-bound water IN PLACE so every subsequent turn stops replaying it
        // instead of re-poisoning each turn (#3833 root cause 3: the water is a
        // session-level scalar with no model dimension). A water at/below the
        // ceiling keeps the pre-existing raise-to-ceiling rescue (#1665/#1840);
        // with no water the ceiling floors the restore (unchanged).
        if (highWater !== undefined && highWater > ceiling) {
            session.metadata.outputBudgetHighWater = ceiling;
            log("warn", `[${session.id}] output budget high-water ${highWater} exceeds ${modelName}'s declared output ceiling ${ceiling} — corrected the session high-water to the ceiling in place so subsequent turns stop replaying the over-bound value (#3833: a cross-model high-water must not outlive its origin model)`);
        }
        target = ceiling;
    } else if (target === undefined || target < OUTPUT_HIGH_WATER_TRUST_MIN) {
        // #3071 path 1 + path 2b: a starved budget with NO usable bound of its
        // own must never leave the proxy verbatim — a fresh fork child inherits
        // the parent's rattle with no high-water, and a death-rattle high-water
        // (below OUTPUT_HIGH_WATER_TRUST_MIN) is itself the poisoned quantity,
        // so both fall to the capability floor.
        // #3406: a high-water AT/ABOVE the trust line is the session's own
        // proven budget — the healthy branch forwarded it verbatim and the
        // provider accepted it at full value — so it is an explicit smaller
        // legal bound. Never raise above it: a provider hard-capping
        // maxOutputTokens below this floor rejects the raised value outright
        // (400), trading a degraded-but-working session for a failing one
        // (availability over ideology, #3128).
        target = OUTPUT_RESTORE_ABSOLUTE_FLOOR;
    }
    if (typeof target === "number") {
        writeOutputBudget(p, field, target);
        const note = ceiling !== undefined
            ? (highWater === undefined
                ? "; no healthy high-water yet — using known output ceiling (#1665/#1840)"
                : (highWater > ceiling
                    ? `; high-water ${highWater} exceeded the ceiling — clamped to it and the water corrected in place (#3833)`
                    : `; high-water ${highWater} below known output ceiling — floored (#1665/#1840)`))
            : (target === highWater
                ? "; no known output ceiling — restored to the session's own recorded budget, never raised above it (#3406)"
                : "; no known output ceiling — floored to the absolute capability minimum (#3071)");
        // #3438: the <=200 starve keeps its original wording; a mid-band
        // collapse names itself so the incident log distinguishes the two entries.
        const origin = collapsed && value > SIDE_REQUEST_MAX_TOKENS
            ? "#3438: dsh-lane mid-band collapse above the <=200 starve gate"
            : "#546: client shrank it from its raw-history estimate";
        log("info", `[${session.id}] output budget restored ${value} -> ${target} (${origin}${note})`);
    }
    // #2904: persist the no-ceiling degraded state for the user-visible surfaces.
    // With the #3071 absolute floor a ceiling-less starve is ALWAYS restored (never
    // forwarded verbatim), so target is always a number in that branch.
    if (ceiling !== undefined) clearNoCeilingDegraded(session, modelName);
    else session.metadata.outputBudgetDegraded = { model: modelName, value: typeof target === "number" ? target : value, ts: Date.now() };
    if (ceiling === undefined && noteNoOutputCeilingWarning(session.id, modelName)) {
        log("warn", noCeilingWarnText(session.id, modelName, value, typeof target === "number" ? target : value));
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
 *  reservation on routes that carry one (#4205: decided by the caller via
 *  shouldReserveOutputHeadroom with route+model evidence — the guard stays
 *  pure mechanics and self-reserves once from the UNRESERVED limit it is
 *  handed). blocked=false with limit<=0 means "window unknown — forward as
 *  before". blocked requires estimate >= limit x SIDE_REQUEST_GUARD_TOLERANCE
 *  (estimator bias). */
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
    /** #4205: whether THIS route reserves the output budget from the window —
     *  policy lives at the call site (shouldReserveOutputHeadroom sees route +
     *  model evidence the guard cannot); default false keeps non-reserving
     *  callers byte-identical. */
    reserveHeadroom: boolean = false,
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
    if (reserveHeadroom && limit > 0) limit = reserveOutputHeadroom(limit, maxOut, headroomCap);
    const imageMass = imageReserve ?? imageTokensInParsedBody(protocol, parsed, imageBilling, configuredCap);
    const estimate = estimateRawBodyTokens(parsed) + imageMass;
    return { blocked: limit > 0 && estimate >= limit * SIDE_REQUEST_GUARD_TOLERANCE, estimate, limit };
}
