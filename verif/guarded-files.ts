/**
 * Guarded file list for the symbolic-verification subset ("verif-subset").
 *
 * Everything listed here must stay inside the translatable sublanguage
 * (see verif/subset-guard.ts). Anything the symbolic executor cannot
 * compile needs an explicit, reviewed exception in verif/exceptions.ts —
 * there is no silent escape hatch.
 *
 * Grow this list only together with translator coverage, never ahead of it.
 */
export const GUARDED_FILES: readonly string[] = [
  // Tier A — current translator targets
  "kernel/src/compress.ts",
  "kernel/src/hide-consumed.ts",
  "kernel/src/refs.ts",
  "kernel/src/render-refs.ts",
  "kernel/src/truncate.ts",
  "kernel/src/truncate-tools.ts",
  "kernel/src/tokenize.ts",
  "kernel/src/rebuild.ts",
  "kernel/src/wire/openai.ts",
  "kernel/src/wire/responses.ts",
  // #3989 phase 1 — the #3956 fold-gate state machines
  "kernel/src/view-latch.ts",
];
