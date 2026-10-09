import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig } from "../src/config.js";
import { DEFAULT_ABSORB_CONFIG, resolveAbsorbConfig } from "../src/absorb.js";
import { DEFAULT_CCR_CONFIG, resolveCcrConfig } from "../src/ccr.js";
import type { Config } from "../src/types.js";

// #2510 (migrated from acp-kernel#502, pattern of acp-kernel PR #503): the
// type surface was stricter than actual usage — AbsorbConfig/CcrConfig
// declared every field required while consumers merge per-field defaults.
// Partial blocks are legal input; `enabled` is the activation switch.

test("partial absorb block typechecks against Config (TS2739 repro)", () => {
  // Compile-time assertion: this assignment failed with TS2739 before the
  // fix (toolName/minToolTokens/contextThresholdPct/excludeTools missing).
  const cfg: Config = defaultConfig(200_000, { absorb: { enabled: true } });
  assert.deepEqual(validateConfig(cfg), []);
});

test("partial ccr block typechecks against Config (TS2739 repro)", () => {
  const cfg: Config = defaultConfig(200_000, { ccr: { enabled: true } });
  assert.deepEqual(validateConfig(cfg), []);
});

test("resolveAbsorbConfig fills every absent field from defaults", () => {
  const resolved = resolveAbsorbConfig(defaultConfig(100_000, {
    absorb: { enabled: true },
  }));
  assert.deepEqual(resolved, {
    enabled: true,
    toolName: "absorb",
    minToolTokens: 4000,
    contextThresholdPct: 0,
    excludeTools: [],
  });
  assert.deepEqual(resolved, { ...DEFAULT_ABSORB_CONFIG, enabled: true });
});

test("resolveCcrConfig fills every absent field from defaults", () => {
  const resolved = resolveCcrConfig(defaultConfig(100_000, {
    ccr: { enabled: true },
  }));
  assert.deepEqual(resolved, {
    enabled: true,
    toolName: "acp_retrieve",
    minToolTokens: 4000,
    excludeTools: [],
    maxHeadChars: 96,
    retrieveInlineTokens: 4000,
  });
  assert.deepEqual(resolved, { ...DEFAULT_CCR_CONFIG, enabled: true });
});

test("explicit values still win over defaults in both resolvers", () => {
  const absorb = resolveAbsorbConfig(defaultConfig(100_000, {
    absorb: {
      enabled: true,
      toolName: "acp_absorb",
      minToolTokens: 123,
      contextThresholdPct: 0.5,
      excludeTools: ["bash"],
    },
  }));
  assert.deepEqual(absorb, {
    enabled: true,
    toolName: "acp_absorb",
    minToolTokens: 123,
    contextThresholdPct: 0.5,
    excludeTools: ["bash"],
  });
  const ccr = resolveCcrConfig(defaultConfig(100_000, {
    ccr: { enabled: true, maxHeadChars: 64, retrieveInlineTokens: 8000 },
  }));
  assert.equal(ccr.toolName, "acp_retrieve");
  assert.equal(ccr.minToolTokens, 4000);
  assert.deepEqual(ccr.excludeTools, []);
  assert.equal(ccr.maxHeadChars, 64);
  assert.equal(ccr.retrieveInlineTokens, 8000);
});

test("validateConfig: partial blocks pass, explicit empty toolName still fails", () => {
  assert.deepEqual(
    validateConfig(defaultConfig(100_000, { absorb: { enabled: true } })),
    [],
  );
  assert.deepEqual(
    validateConfig(defaultConfig(100_000, { ccr: { enabled: true } })),
    [],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(100_000, { absorb: { enabled: true, toolName: "" } }),
    ),
    ["absorb.toolName must be a non-empty string when enabled"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(100_000, { ccr: { enabled: true, toolName: "" } }),
    ),
    ["ccr.toolName must be a non-empty string when enabled"],
  );
});

test("validateConfig: numeric bounds still enforced when present", () => {
  assert.deepEqual(
    validateConfig(
      defaultConfig(100_000, { absorb: { minToolTokens: -1 } }),
    ),
    ["absorb.minToolTokens must be >= 0"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(100_000, { absorb: { contextThresholdPct: 1.5 } }),
    ),
    ["absorb.contextThresholdPct must be in [0, 1]"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(100_000, { ccr: { minToolTokens: -1 } }),
    ),
    ["ccr.minToolTokens must be >= 0"],
  );
  assert.deepEqual(
    validateConfig(defaultConfig(100_000, { ccr: { maxHeadChars: -1 } })),
    ["ccr.maxHeadChars must be >= 0"],
  );
});
