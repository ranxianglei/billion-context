// Registered deviations from the sub-language guard (#3853). This file is
// audited inventory: every entry must match exactly one live violation at
// scan time, and an entry that matches nothing is itself a guard failure
// (stale inventory) — see evaluate() in subset-guard.ts.

export interface GuardException {
  id: string;
  file: string; // repo-relative path of a guarded file
  rule: string; // RuleId from subset-guard.ts
  fn: string; // innermost enclosing function name ('<module>' for top level)
  expr: string; // normalized offending expression (whitespace-collapsed)
  reason: string; // why this deviation cannot break the verified invariants
}

export interface ExcludedFunction {
  id: string;
  file: string; // repo-relative path of a guarded file
  fn: string; // function whose whole body is skipped by the guard
  regions?: [number, number][]; // extra line ranges belonging to the same feature (module-level parts)
  reason: string;
}

export const EXCEPTIONS: GuardException[] = [
  {
    id: "ex-compress-date",
    file: "kernel/src/compress.ts",
    rule: "unknown-global",
    fn: "applySingleRange",
    expr: "Date",
    reason:
      "Date.now() stamps createdAt on block records only. Wall-clock metadata never feeds a compression decision, a ref assignment, or any invariant under verification.",
  },
  {
    id: "ex-compress-console",
    file: "kernel/src/compress.ts",
    rule: "unknown-global",
    fn: "processTurn",
    expr: "console",
    reason:
      "console.warn surfaces config-validation warnings to the host log. Pure output side channel: it reads nothing back and cannot change returned state or messages.",
  },
  {
    id: "ex-responses-env",
    file: "kernel/src/wire/responses.ts",
    rule: "env-access",
    fn: "shouldDropAllReasoning",
    expr: "process",
    reason:
      "process.env.ACP_REASONING_KEEP is a documented operator toggle (CONFIGURATION.md), constant per process lifetime. It selects between two fixed codec behaviors; no model traffic or session state flows into it.",
  },
  {
    id: "ex-compress-protectedfn",
    file: "kernel/src/compress.ts",
    rule: "closure-escape",
    fn: "run",
    expr: "protectedFn",
    reason:
      "protectedFn is passed to assignRefs as the isProtected predicate. It captures only immutable locals computed earlier in run() (hasProtection, latest, pathProtectedCallIds, ctx) — no captured mutable state, so the escape introduces no aliasing the translator must track.",
  },
];

export const EXCLUDED_FUNCTIONS: ExcludedFunction[] = [
  {
    id: "exc-tokenize-bpe",
    file: "kernel/src/tokenize.ts",
    fn: "createBpeTokenizer",
    regions: [
      [1, 3],
    ],
    reason:
      "Optional BPE tokenizer probe: dynamically requires @anthropic-ai/tokenizer (optional dependency) and falls back to the pure defaultCountTokens when absent or throwing. Token-count heuristic outside the decision-core invariants; lines 1-3 hold the same feature's createRequire binding.",
  },
];
