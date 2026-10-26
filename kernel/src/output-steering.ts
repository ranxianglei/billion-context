/**
 * Output-side steering decisions (#355): turn-structure classification,
 * verbosity levels (L0–L4), clamp-only effort routing.
 *
 * This module is the protocol-agnostic half of output-side compression. It
 * DECIDES; adapters LAND. Adapters (e.g. billion-context) own:
 *   - mapping their wire body onto `StructuralMessage[]` (contract below),
 *   - writing the decision onto wire-specific fields (effort field names,
 *     system-prompt carriers, numeric budget floors),
 *   - config persistence and logging of returned warnings.
 *
 * Hard boundaries:
 *   1. CLAMP-ONLY — `lowerEffort` never means "raise". Adapters lower only
 *      effort fields the client ALREADY sent; absent fields are never
 *      injected (models without effort support 400 on them), and values
 *      at/below the floor are left alone (`clampEffortToFloor`).
 *   2. TAIL-ONLY injection — the verbosity directive goes at the TAIL of the
 *      system prompt (prefix cache requires stable head bytes; never prepend).
 *      `applySteeringToPrompt` replaces an existing sentinel block in place,
 *      so re-applying the same level is a byte-stable no-op (compress retries
 *      re-send through this path).
 *   3. BYTE-STABLE directives — the L1–L4 texts below are frozen across
 *      releases. Editing one character busts the prefix cache of every
 *      session pinned at that level. Change only with a deliberate,
 *      announced cache bust.
 *
 * Origin: decision logic adapted from billion-context PR#1096
 * (`2026-09-21_output-side-compression`, `src/output-steering.ts`; design per
 * headroomlabs-ai/headroom's output-token-reduction proposal). Per-wire rules
 * are preserved here as the normalization contract; wire-side landing stays
 * in adapters.
 */

export type TurnKind =
  "new_user_ask" | "mechanical_continuation" | "error_continuation" | "unknown";

export interface StructuralBlock {
  /**
   * `text` / `image` / `document` — user signal ⇒ new_user_ask.
   * `tool_result` — machine-produced result; accumulates toward a
   * continuation verdict.
   */
  kind: "text" | "image" | "document" | "tool_result";
  /** `tool_result` only: the wire's error flag (Anthropic `is_error`). Absent = clean. */
  isError?: boolean;
}

export interface StructuralMessage {
  role: string;
  /** Plain-string content (Anthropic/OpenAI allow string content). Mutually exclusive with `blocks` in practice; `text` wins when both present. */
  text?: string;
  blocks?: StructuralBlock[];
}

/**
 * Classify the FINAL turn purely structurally — block composition only, no
 * content pattern-matching. Only the last message matters. Conservative by
 * design: anything unrecognized yields `unknown` (never a guess), because an
 * unrecognized composition may carry user intent we cannot see.
 */
export function classifyTurn(messages: readonly StructuralMessage[]): TurnKind {
  if (messages.length === 0) return "unknown";
  const last = messages[messages.length - 1]!;
  if (!last || last.role !== "user") return "unknown";
  if (typeof last.text === "string")
    return last.text.trim() ? "new_user_ask" : "unknown";
  const blocks = last.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return "unknown";
  let sawToolResult = false;
  let sawError = false;
  for (const b of blocks) {
    if (!b) return "unknown";
    switch (b.kind) {
      case "tool_result":
        sawToolResult = true;
        if (b.isError === true) sawError = true;
        break;
      case "text":
      case "image":
      case "document":
        return "new_user_ask";
      default:
        return "unknown";
    }
  }
  if (sawError) return "error_continuation";
  if (sawToolResult) return "mechanical_continuation";
  return "unknown";
}

/**
 * Normalization contract (adapter responsibility — documented here because
 * classification correctness depends on it):
 *
 *  - Anthropic: pass through. String content → `text`; content blocks map by
 *    `type`: text/image/document → same kind; tool_result → tool_result with
 *    `isError = block.is_error === true`.
 *  - OpenAI chat: fold trailing consecutive `role:"tool"` messages into ONE
 *    synthetic final user message carrying tool_result blocks (no error flag
 *    exists on this wire → `isError` stays absent). A trailing user message
 *    passes through (string content → `text`; array content: non-empty text
 *    part → text block, otherwise unknown).
 *  - Responses: walk `input` BACKWARD from the end (clients re-send full
 *    history every request — scanning forward would hit the original ask on
 *    every turn). Items after the last user signal: `*_call_output`
 *    (function/custom_tool/local_shell/apply_patch) → tool_result blocks;
 *    assistant-side items (message/function_call/custom_tool_call/
 *    local_shell_call/apply_patch_call/reasoning) form the preceding
 *    assistant message(s). User signal = `input_text` (non-empty),
 *    `input_image`, `input_file`, or a role:"user" message with non-empty
 *    text. Trailing outputs ⇒ final user(tool_results); none ⇒ final
 *    user(text); pending call with no output yet ⇒ unknown.
 *  - Google: the last `contents` entry must be role:"user"; parts map:
 *    functionResponse → tool_result; non-empty text → text; empty text →
 *    dropped (neutral); inlineData/fileData/videoMetadata → image/document.
 *
 * Anything unrecognized maps to nothing (→ `unknown`), never to a guess.
 */

export const MIN_VERBOSITY_LEVEL = 0;
export const MAX_VERBOSITY_LEVEL = 4;
export const DEFAULT_VERBOSITY_LEVEL = 2;

/** Conciseness directives L1–L4. L0 = no directive. FROZEN across releases. */
export const VERBOSITY_LEVELS: Readonly<Record<number, string>> = {
  1: "Skip preamble and postamble. Do not announce what you are about to do or recap what you just did; start with the substance.",
  2: "Skip preamble and postamble; start with the substance. Never restate code, file contents, diffs, or tool output that already appear in this conversation — reference them by path and line instead. After a tool call succeeds, continue without narrating the result.",
  3: "Skip preamble and postamble. Never restate code, file contents, diffs, or tool output already in this conversation — cite the exact file path and line or symbol instead, always; a reference that omits the location is not a reference. Give conclusions only; omit rationale unless the user asks why. Prefer the smallest edit over rewriting whole files. Keep prose to the minimum needed to be unambiguous. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except) — shorten how you say it, not what you say. Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.",
  4: "Minimum tokens. Fragments fine. No preamble, no postamble, no restating context, no rationale. Answer, smallest-possible edits, nothing else. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except). Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.",
};

export function verbosityDirective(level: number): string | null {
  if (!Number.isInteger(level)) return null;
  return VERBOSITY_LEVELS[level] ?? null;
}

/**
 * Default sentinel wrapping the steering directive. Each host SHOULD pass its
 * own sentinel so a body that passes through several proxies never collides
 * (billion-context uses `<bili_output_steering>`). Must be a full opening
 * XML-style tag `<name>`; the closing tag is derived as `</name>`.
 */
export const DEFAULT_STEERING_SENTINEL = "<acp_output_steering>";

export function renderSteeringBlock(
  level: number,
  sentinel: string = DEFAULT_STEERING_SENTINEL,
): string | null {
  const text = verbosityDirective(level);
  if (text === null) return null;
  return `${sentinel}\n${text}\n</${sentinel.slice(1)}`;
}

export interface SteeringPlacement {
  updated: string;
  changed: boolean;
}

/**
 * Idempotently place `block` in `existing`: when a block wrapped by
 * `sentinel` is present, replace it in place (preserving surrounding text);
 * otherwise append at the tail. Never prepends. Re-applying the same block
 * returns `changed: false` with byte-identical output (retry safety). A
 * malformed (unclosed) sentinel block is consumed to the end of the string
 * so re-application neither duplicates the closing tag nor grows the block.
 */
export function applySteeringToPrompt(
  existing: string,
  block: string,
  sentinel: string = DEFAULT_STEERING_SENTINEL,
): SteeringPlacement {
  const suffix = `</${sentinel.slice(1)}`;
  const start = existing.indexOf(sentinel);
  if (start >= 0) {
    const found = existing.indexOf(suffix, start);
    const end = found < 0 ? existing.length : found + suffix.length;
    const prefix = existing.slice(0, start).replace(/\s+$/, "");
    const tail = existing.slice(end).replace(/^\n+/, "");
    const parts = [prefix, block, tail].filter((p) => p.length > 0);
    const updated = parts.join("\n\n");
    return { updated, changed: updated !== existing };
  }
  const trimmed = existing.trim();
  const updated =
    trimmed.length > 0 ? `${existing.replace(/\s+$/, "")}\n\n${block}` : block;
  return { updated, changed: updated !== existing };
}

/**
 * Ascending shared effort ladder (OpenAI chat / Responses / Anthropic
 * output_config.effort use these values). Wire-specific NUMERIC budget floors
 * (e.g. Anthropic thinking.budget_tokens ≥ 1024, Google thinkingBudget ≥ 128,
 * dynamic `-1` untouched) live adapter-side — they are properties of wire
 * fields, not of the decision.
 */
export const EFFORT_LADDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type EffortValue = (typeof EFFORT_LADDER)[number];

/**
 * Clamp-only floor computation. Returns the value to write, or null when the
 * field is absent/unrecognized or already at/below `floor`. Never raises: a
 * client that explicitly asked for `minimal` keeps it. Unrecognized values
 * are left untouched rather than coerced — coercing an unknown value that
 * happens to sit below the floor would be a raise.
 */
export function clampEffortToFloor(
  current: unknown,
  floor: EffortValue = "low",
): EffortValue | null {
  if (typeof current !== "string") return null;
  const ci = (EFFORT_LADDER as readonly string[]).indexOf(current);
  if (ci === -1) return null;
  const fi = EFFORT_LADDER.indexOf(floor);
  return ci > fi ? floor : null;
}

export interface OutputSteeringConfig {
  /** Master switch. Default OFF — both levers inert until explicitly on. */
  enabled: boolean;
  /** Verbosity level 0–4 (0 = no directive). Default 2. */
  verbosityLevel: number;
  /** Effort-routing sub-switch. Default on whenever `enabled` is. */
  effortRouting: boolean;
}

export const DEFAULT_OUTPUT_STEERING_CONFIG: OutputSteeringConfig = {
  enabled: false,
  verbosityLevel: DEFAULT_VERBOSITY_LEVEL,
  effortRouting: true,
};

/**
 * Resolve a raw verbosity level. An OMITTED field silently takes the default;
 * a PRESENT but out-of-range value falls back WITH a warning (honest output —
 * a valid partial config must not be accused of being malformed).
 */
export function resolveVerbosityLevel(v: unknown): {
  level: number;
  warning?: string;
} {
  if (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_VERBOSITY_LEVEL &&
    v <= MAX_VERBOSITY_LEVEL
  ) {
    return { level: v };
  }
  const level = DEFAULT_OUTPUT_STEERING_CONFIG.verbosityLevel;
  if (v === undefined) return { level };
  return {
    level,
    warning: `[config] outputSteering.verbosityLevel must be an integer ${MIN_VERBOSITY_LEVEL}-${MAX_VERBOSITY_LEVEL}; got ${JSON.stringify(v)} — falling back to ${level}`,
  };
}

/**
 * Validate a raw `outputSteering` config value (e.g. parsed JSON). Malformed
 * fields fall back to defaults rather than throwing; warnings are returned
 * as data for the host to log. Non-object input yields pure defaults.
 */
export function resolveOutputSteeringConfig(v: unknown): {
  config: OutputSteeringConfig;
  warnings: string[];
} {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { config: DEFAULT_OUTPUT_STEERING_CONFIG, warnings: [] };
  }
  const obj = v as Record<string, unknown>;
  const lvl = resolveVerbosityLevel(obj.verbosityLevel);
  return {
    config: {
      enabled: obj.enabled === true,
      verbosityLevel: lvl.level,
      effortRouting: obj.effortRouting !== false,
    },
    warnings: lvl.warning ? [lvl.warning] : [],
  };
}

export interface OutputSteeringDecision {
  /** Structural classification of the final turn (echoed for observability/logging). */
  turnKind: TurnKind;
  /** Level to inject; 0 = inject nothing. Always 0 while disabled. */
  verbosityLevel: number;
  /**
   * Clamp-only routing: true ⇔ enabled && effortRouting && mechanical
   * continuation. The adapter lowers each effort field the client already
   * sent toward its wire floor; it never injects absent fields and never
   * raises any value.
   */
  lowerEffort: boolean;
}

/**
 * Single decision entry point: structural summary of the FINAL message list
 * (+ resolved config) → steering decision. Pure, synchronous, side-effect
 * free. Landing — which field gets written, which carrier holds the system
 * prompt — is the adapter's job.
 */
export function decideOutputSteering(
  messages: readonly StructuralMessage[],
  config: OutputSteeringConfig = DEFAULT_OUTPUT_STEERING_CONFIG,
): OutputSteeringDecision {
  const turnKind = classifyTurn(messages);
  return {
    turnKind,
    verbosityLevel: config.enabled ? config.verbosityLevel : 0,
    lowerEffort:
      config.enabled &&
      config.effortRouting &&
      turnKind === "mechanical_continuation",
  };
}
