import type { CompressionState, Config, RuleRecord } from "./types.js";

/**
 * Persistent rules ("acp_rule") — durable reminders recorded for future turns
 * (kernel #282, from billion-context-pi#433). The adapter injects
 * formatRulesForPrompt(state) into the system prompt every turn, and acp_rule
 * tool calls/results are hard-protected from compression
 * (ALWAYS_PROTECTED_TOOLS), so a recorded rule survives context compaction.
 *
 * State-mutating helpers: hosts hold live CompressionState objects (a session's
 * single state instance) and discard returned states — these helpers update
 * `state` in place and return only an ok/error result. All mutations stay
 * shallow-copy-free: the rules array is replaced (not spliced) so hosts that
 * captured listRules() output keep a stable snapshot.
 */

export const RULE_TOOL_NAME = "acp_rule";

export interface RuleLimits {
  maxRules: number;
  maxRuleChars: number;
}

export const DEFAULT_RULE_LIMITS: Readonly<RuleLimits> = Object.freeze({
  maxRules: 50,
  maxRuleChars: 300,
});

export const RULES_USAGE_PROMPT = [
  "Use the acp_rule tool to record short, principle-level reminders that must survive context compression:",
  "- behavioral corrections the user has had to repeat more than once,",
  "- project invariants the user explicitly asked you to remember,",
  "- pitfalls you ran into once and must not run into again.",
  "Rules are re-injected into the system prompt every turn. Omit the text argument to list recorded rules.",
].join("\n");

export function listRules(state: CompressionState): RuleRecord[] {
  return state.rules ?? [];
}

/** Effective limits: `config.rules` overrides on top of the defaults. Hosts
 *  resolving per-request configs pass the resolved Config here (billion-context
 *  three-level merge / pi acp.json both land in Config.rules). */
export function resolveRuleLimits(config?: Pick<Config, "rules">): RuleLimits {
  return {
    maxRules: config?.rules?.maxRules ?? DEFAULT_RULE_LIMITS.maxRules,
    maxRuleChars:
      config?.rules?.maxRuleChars ?? DEFAULT_RULE_LIMITS.maxRuleChars,
  };
}

const RULE_ID_RE = /^rule(\d+)$/;

function highestRuleNumber(state: CompressionState): number {
  let highest = 0;
  for (const rule of state.rules ?? []) {
    const match = RULE_ID_RE.exec(rule.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/** Pure (unlike the mutating addRule/removeRule/clearRules): returns the id
 *  the next addRule call would issue, without touching state. Never re-issues
 *  an issued id, even after removal: the counter is monotonic and the
 *  hand-crafted-state guard backfills it from the highest surviving id. */
export function allocateRuleId(state: CompressionState): string {
  return `rule${Math.max(state.nextRuleId ?? 1, highestRuleNumber(state) + 1)}`;
}

export type AddRuleResult =
  { ok: true; rule: RuleRecord } | { ok: false; error: string };

export function addRule(
  state: CompressionState,
  text: string,
  limits: Partial<RuleLimits> = {},
): AddRuleResult {
  const maxRules = limits.maxRules ?? DEFAULT_RULE_LIMITS.maxRules;
  const maxRuleChars = limits.maxRuleChars ?? DEFAULT_RULE_LIMITS.maxRuleChars;
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "rule text is empty — provide the reminder to record.",
    };
  }
  if (trimmed.length > maxRuleChars) {
    return {
      ok: false,
      error: `${trimmed.length} chars exceeds the ${maxRuleChars}-char limit — keep rules short and principle-level.`,
    };
  }
  const rules = listRules(state);
  const duplicate = rules.find((rule) => rule.text === trimmed);
  if (duplicate) {
    return {
      ok: false,
      error: `identical rule already exists (${duplicate.id}) — no change.`,
    };
  }
  if (rules.length >= maxRules) {
    return {
      ok: false,
      error: `rule limit reached (${maxRules}) — remove or clear outdated rules first.`,
    };
  }
  const next = Math.max(state.nextRuleId ?? 1, highestRuleNumber(state) + 1);
  const rule: RuleRecord = { id: `rule${next}`, text: trimmed };
  state.rules = [...rules, rule];
  state.nextRuleId = next + 1;
  return { ok: true, rule };
}

export type RemoveRuleResult =
  { ok: true; rule: RuleRecord } | { ok: false; error: string };

export function removeRule(
  state: CompressionState,
  id: string,
): RemoveRuleResult {
  const rules = listRules(state);
  const target = rules.find((rule) => rule.id === id.trim());
  if (!target) {
    return {
      ok: false,
      error: `no rule with id "${id.trim()}" — list current rules first (omit the text argument).`,
    };
  }
  state.rules = rules.filter((rule) => rule.id !== target.id);
  return { ok: true, rule: target };
}

export interface ClearRulesResult {
  ok: true;
  count: number;
}

export function clearRules(state: CompressionState): ClearRulesResult {
  const count = listRules(state).length;
  state.rules = [];
  return { ok: true, count };
}

/** System-prompt section for adapters with rules enabled. Returns "" when no
 *  rules exist so empty sessions pay zero tokens. */
export function formatRulesForPrompt(state: CompressionState): string {
  const rules = listRules(state);
  if (rules.length === 0) return "";
  return [
    "# Persistent rules (recorded via acp_rule — kept across compression)",
    ...rules.map((rule) => `- [${rule.id}] ${rule.text}`),
  ].join("\n");
}

/** Plain numbered rendering for the acp_rule tool result when the model lists
 *  rules (billion-context#750 executeRule returns this verbatim). */
export function formatRulesList(rules: RuleRecord[]): string {
  return rules
    .map((rule, i) => `${i + 1}. [${rule.id}] ${rule.text}`)
    .join("\n");
}
