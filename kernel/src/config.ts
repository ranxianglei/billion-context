import type { Config } from "./types.js";

export function defaultConfig(
  modelContextLimit: number,
  overrides: Partial<Config> = {},
): Config {
  const base: Config = {
    tiers: { enabled: true, tier2Trigger: 1000, tier3Trigger: 2000 },
    nudge: {
      maxContextLimitPct: 0.75,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 50000,
      growthCap: 50000,
      minGrowthFloor: 20000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.95,
      tier2GrowthMultiplier: 1.5,
    },
    promotionThreshold: 5,
    truncate: { threshold: 0.95, terminalEscapeAfter: 3 },
    compress: {
      minCompressRange: 1250,
      maxSummaryLength: 20000,
      minSummaryLength: 50,
    },
    protectedTools: [],
    protectedLatestTools: [],
    preserveRecentMessages: 5,
    preserveRecentTokens: 5000,
    modelContextLimit,
    absorb: {
      enabled: false,
      toolName: "absorb",
      // Raised 1000 → 4000 (issue #352): lossless CCR takes over large-result
      // handling; absorb's forced distillation only fires above the new bar.
      minToolTokens: 4000,
      contextThresholdPct: 0,
      excludeTools: [],
    },
    crush: {
      enabled: false,
      minReduction: 0.1,
    },
    imageCompression: {
      enabled: false,
      minTokens: 512,
      maxDimension: 1280,
      quality: 80,
      format: "webp",
    },
    ccr: {
      enabled: false,
      toolName: "acp_retrieve",
      minToolTokens: 4000,
      excludeTools: [],
      maxHeadChars: 96,
    },
  };
  return {
    ...base,
    ...overrides,
    tiers: { ...base.tiers, ...overrides.tiers },
    nudge: { ...base.nudge, ...overrides.nudge },
    truncate: { ...base.truncate, ...overrides.truncate },
    compress: { ...base.compress, ...overrides.compress },
    absorb: overrides.absorb
      ? { ...base.absorb, ...overrides.absorb }
      : base.absorb,
    crush: overrides.crush ? { ...base.crush, ...overrides.crush } : base.crush,
    imageCompression: overrides.imageCompression
      ? { ...base.imageCompression, ...overrides.imageCompression }
      : base.imageCompression,
    ccr: overrides.ccr ? { ...base.ccr, ...overrides.ccr } : base.ccr,
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  if (
    !Number.isFinite(config.modelContextLimit) ||
    config.modelContextLimit <= 0
  ) {
    errors.push("modelContextLimit must be a positive number");
  }
  if (config.nudge.minContextLimitPct > config.nudge.maxContextLimitPct) {
    errors.push(
      "nudge.minContextLimitPct must not exceed nudge.maxContextLimitPct",
    );
  }
  if (config.nudge.maxContextLimitPct > config.nudge.emergencyThresholdPct) {
    errors.push(
      "nudge.maxContextLimitPct must not exceed nudge.emergencyThresholdPct",
    );
  }
  if (
    config.nudge.minPressureBenefitTokens !== undefined &&
    (!Number.isFinite(config.nudge.minPressureBenefitTokens) ||
      config.nudge.minPressureBenefitTokens < 0)
  ) {
    errors.push("nudge.minPressureBenefitTokens must be finite and >= 0");
  }
  if (config.promotionThreshold < 1) {
    errors.push("promotionThreshold must be >= 1");
  }
  if (config.truncate.threshold <= 0 || config.truncate.threshold > 1) {
    errors.push("truncate.threshold must be in (0, 1]");
  }
  if (
    config.truncate.terminalEscapeAfter !== undefined &&
    (!Number.isInteger(config.truncate.terminalEscapeAfter) ||
      config.truncate.terminalEscapeAfter < 0)
  ) {
    errors.push("truncate.terminalEscapeAfter must be an integer >= 0");
  }
  for (const tier of [config.tiers.tier2Trigger, config.tiers.tier3Trigger]) {
    if (tier < 1) errors.push("tier triggers must be >= 1");
  }
  if (config.tiers.tier3Trigger <= config.tiers.tier2Trigger) {
    errors.push("tiers.tier3Trigger must be greater than tiers.tier2Trigger");
  }
  if (config.nudge.tierGrowthTokens !== undefined) {
    for (const [tier, value] of Object.entries(config.nudge.tierGrowthTokens)) {
      if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
        errors.push(`nudge.tierGrowthTokens.${tier} must be a positive number`);
      }
    }
  }
  if (
    config.neverPreserveRecentTools !== undefined &&
    (!Array.isArray(config.neverPreserveRecentTools) ||
      config.neverPreserveRecentTools.some((t) => typeof t !== "string"))
  ) {
    errors.push("neverPreserveRecentTools must be a string array");
  }
  if (
    config.preserveRecentTools !== undefined &&
    (!Array.isArray(config.preserveRecentTools) ||
      config.preserveRecentTools.some((t) => typeof t !== "string"))
  ) {
    errors.push("preserveRecentTools must be a string array");
  }
  if (config.absorb) {
    if (config.absorb.enabled && !config.absorb.toolName) {
      errors.push("absorb.toolName must be a non-empty string when enabled");
    }
    if (
      !Number.isFinite(config.absorb.minToolTokens) ||
      config.absorb.minToolTokens < 0
    ) {
      errors.push("absorb.minToolTokens must be >= 0");
    }
    if (
      config.absorb.contextThresholdPct < 0 ||
      config.absorb.contextThresholdPct > 1
    ) {
      errors.push("absorb.contextThresholdPct must be in [0, 1]");
    }
  }
  if (config.rules) {
    if (
      config.rules.maxRules !== undefined &&
      (!Number.isFinite(config.rules.maxRules) || config.rules.maxRules < 1)
    ) {
      errors.push("rules.maxRules must be >= 1");
    }
    if (
      config.rules.maxRuleChars !== undefined &&
      (!Number.isFinite(config.rules.maxRuleChars) ||
        config.rules.maxRuleChars < 1)
    ) {
      errors.push("rules.maxRuleChars must be >= 1");
    }
  }
  if (config.crush) {
    if (
      !Number.isFinite(config.crush.minReduction) ||
      config.crush.minReduction <= 0 ||
      config.crush.minReduction > 1
    ) {
      errors.push("crush.minReduction must be in (0, 1]");
    }
    if (config.crush.strategies) {
      for (const [id, ov] of Object.entries(config.crush.strategies)) {
        if (!ov || typeof ov !== "object" || Array.isArray(ov)) {
          errors.push(`crush.strategies.${id} must be an object`);
          continue;
        }
        if (ov.enabled !== undefined && typeof ov.enabled !== "boolean") {
          errors.push(`crush.strategies.${id}.enabled must be a boolean`);
        }
        if (
          ov.excludeTools !== undefined &&
          (!Array.isArray(ov.excludeTools) ||
            ov.excludeTools.some((t) => typeof t !== "string"))
        ) {
          errors.push(
            `crush.strategies.${id}.excludeTools must be a string array`,
          );
        }
      }
    }
  }
  if (config.imageCompression) {
    const ic = config.imageCompression;
    if (
      ic.minTokens !== undefined &&
      (!Number.isFinite(ic.minTokens) || ic.minTokens < 0)
    ) {
      errors.push("imageCompression.minTokens must be finite and >= 0");
    }
    if (
      ic.maxDimension !== undefined &&
      (!Number.isInteger(ic.maxDimension) || ic.maxDimension < 16)
    ) {
      errors.push("imageCompression.maxDimension must be an integer >= 16");
    }
    if (
      ic.quality !== undefined &&
      (!Number.isFinite(ic.quality) || ic.quality < 1 || ic.quality > 100)
    ) {
      errors.push("imageCompression.quality must be in [1, 100]");
    }
    if (
      ic.format !== undefined &&
      ic.format !== "webp" &&
      ic.format !== "jpeg" &&
      ic.format !== "png"
    ) {
      errors.push('imageCompression.format must be "webp", "jpeg", or "png"');
    }
  }
  if (config.ccr) {
    if (config.ccr.enabled && !config.ccr.toolName) {
      errors.push("ccr.toolName must be a non-empty string when enabled");
    }
    if (
      !Number.isFinite(config.ccr.minToolTokens) ||
      config.ccr.minToolTokens < 0
    ) {
      errors.push("ccr.minToolTokens must be >= 0");
    }
    if (
      !Number.isFinite(config.ccr.maxHeadChars) ||
      config.ccr.maxHeadChars < 0
    ) {
      errors.push("ccr.maxHeadChars must be >= 0");
    }
  }
  return errors;
}
