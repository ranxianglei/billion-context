/**
 * Explicit exceptions to the verif subset rules.
 *
 * Every entry must carry a human reason. Entries that no longer match
 * anything in the guarded files are reported as stale by the guard test
 * and must be deleted — this list is an audited inventory, not a dumping
 * ground.
 */

/** A whole function scoped out of symbolic verification. Calls to it are
 * treated as uninterpreted; the function body is not checked. Use only for
 * code that is provably off every verified path (e.g. optional ports). */
interface ExcludedFunction {
  file: string;
  fn: string;
  reason: string;
}

export interface SubsetException {
  file: string;
  code: string;
  /** Restrict the exception to one function (by local name). */
  fn?: string;
  /** Restrict to violations whose detail matches exactly. */
  detail?: string;
  reason: string;
}

export const EXCLUDED_FUNCTIONS: readonly ExcludedFunction[] = [
  {
    file: "kernel/src/tokenize.ts",
    fn: "createBpeTokenizer",
    reason:
      "Optional BPE tokenizer probe: node require + returned closures. Never on a verified path — CompressionCore takes countTokens as an injectable port and the verified entry points use defaultCountTokens (pure arithmetic).",
  },
];

export const EXCEPTIONS: readonly SubsetException[] = [
  {
    file: "kernel/src/tokenize.ts",
    code: "NODE_BUILTIN_IMPORT",
    reason:
      "createRequire from node:module at module top feeds only createBpeTokenizer (an excluded function); the verified path (defaultCountTokens) is pure.",
  },
  {
    file: "kernel/src/compress.ts",
    code: "ENV_ACCESS",
    fn: "applySingleRange",
    reason:
      "createdAt: Date.now() — wall-clock stamp on new blocks; orthogonal to every verified invariant, modeled as an unconstrained symbolic integer.",
  },
  {
    file: "kernel/src/compress.ts",
    code: "ENV_ACCESS",
    fn: "processTurn",
    detail: "console.warn",
    reason:
      "Log-only console.warn on a degraded path; modeled as a no-op observation point — never influences verified state.",
  },
  {
    file: "kernel/src/render-refs.ts",
    code: "DYNAMIC_REGEX",
    reason:
      "ownTagRe = new RegExp(escapeRegex(TAG_OPEN)+...+escapeRegex(ref)+...) — pattern is a concatenation of literal fragments with the message ref escaped in; representable as a symbolic regex concatenation once the translator grows dynamic-pattern support. Tracked until then.",
  },
  {
    file: "kernel/src/tokenize.ts",
    code: "UNKNOWN_GLOBAL",
    detail: "createRequire",
    reason:
      "Module-scope const require = createRequire(import.meta.url); only createBpeTokenizer (excluded function) uses it. Verified paths never call it.",
  },
  {
    file: "kernel/src/wire/responses.ts",
    code: "ENV_ACCESS",
    fn: "shouldDropAllReasoning",
    detail: "read process.env",
    reason:
      "process.env.ACP_REASONING_KEEP read — process-wide config constant, modeled as a fixed symbolic boolean, never mutated inside the guarded scope.",
  },
];
