import {
  COMPRESS_PHILOSOPHY,
  HOW_TO_COMPRESS_RULES,
  LANGUAGE_PRESERVATION_RULE,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
} from "./compression-rules.js";

/**
 * Overridable prompt text consumed by the kernel's nudge renderer and, via the
 * adapter, the system prompt. Every field here is LOAD-BEARING: these rules
 * were tuned over months of production use and are quality-critical. Overriding
 * them can degrade summary quality (loss of paths / signatures / decisions →
 * broken retrieval), so {@link resolvePrompts} requires `{ acknowledgeRisk: true }`.
 *
 * Surface-level text (summary section headers, status-report chrome, tool
 * descriptions) is intentionally NOT part of this interface — it is owned by
 * the adapter or a later "prompt-set format" layer and is safe to customize
 * freely. See DESIGN.md for the load-bearing vs surface classification.
 */
export interface Prompts {
  /** Core compression philosophy. Embedded in the system prompt + every nudge. */
  compressPhilosophy: string;
  /** Rules the model follows when writing a tier-1 summary. */
  howToCompressRules: string;
  /** Rules for tier-2 distillation of existing summaries. */
  tier2DistillRules: string;
  /** Rules for tier-3 ultra-condensation of distilled summaries. */
  tier3CondenseRules: string;
}

/**
 * The kernel's canonical prompt values (verbatim from compression-rules.ts).
 * Frozen so a buggy caller cannot mutate the shared singleton and corrupt
 * every other consumer of {@link defaultPrompts}.
 */
export const defaultPrompts: Prompts = Object.freeze({
  compressPhilosophy: COMPRESS_PHILOSOPHY,
  howToCompressRules: HOW_TO_COMPRESS_RULES,
  tier2DistillRules: TIER2_DISTILL_RULES,
  tier3CondenseRules: TIER3_CONDENSE_RULES,
}) as Prompts;

export interface ResolvePromptsOptions {
  /**
   * Must be `true` to override any prompt field. Every {@link Prompts} field is
   * load-bearing; overriding without acknowledging the quality risk is a
   * programming error and throws.
   */
  acknowledgeRisk?: boolean;
  /** Opt in to the language-preservation rule (#493): appends
   * {@link LANGUAGE_PRESERVATION_RULE} to all four canonical rule texts.
   * Additive only — it cannot remove or replace load-bearing wording, so it
   * does NOT require `acknowledgeRisk`. Default off: the resolved prompts are
   * byte-identical to {@link defaultPrompts}. */
  languagePreservation?: boolean;
}

/**
 * Merge prompt overrides onto the kernel defaults. All fields are load-bearing,
 * so ANY override requires `{ acknowledgeRisk: true }`.
 *
 * Only `string`-valued overrides take effect: an explicit `undefined`/`null` or
 * a wrong type is silently dropped (never clobbers a good default), so a
 * malformed partial never degrades the canonical rules. Resolve once at host
 * startup, then pass the resulting {@link Prompts} to {@link renderNudgeText}
 * and to the adapter's system-prompt composition so both layers stay consistent.
 */
export function resolvePrompts(
  overrides?: Partial<Prompts>,
  options: ResolvePromptsOptions = {},
): Prompts {
  const clean: Partial<Prompts> = {};
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string") {
        (clean as Record<string, unknown>)[key] = value;
      }
    }
  }
  const keys = Object.keys(clean) as (keyof Prompts)[];
  if (keys.length > 0 && !options.acknowledgeRisk) {
    throw new Error(
      `resolvePrompts: overriding compression rules requires { acknowledgeRisk: true }. ` +
        `Overridden keys: ${keys.join(", ")}. These rules are quality-critical (tuned over months of production use); ` +
        `changing them can degrade summary quality and break retrieval (summaries may lose paths, signatures, decisions).`,
    );
  }
  const merged: Prompts = { ...defaultPrompts, ...clean };
  if (options.languagePreservation) {
    return {
      compressPhilosophy: `${merged.compressPhilosophy}\n- ${LANGUAGE_PRESERVATION_RULE}`,
      howToCompressRules: `${merged.howToCompressRules}\n\n${LANGUAGE_PRESERVATION_RULE}`,
      tier2DistillRules: `${merged.tier2DistillRules}\n\n${LANGUAGE_PRESERVATION_RULE}`,
      tier3CondenseRules: `${merged.tier3CondenseRules}\n\n${LANGUAGE_PRESERVATION_RULE}`,
    };
  }
  return merged;
}
