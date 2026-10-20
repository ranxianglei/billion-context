# verif/ — decision-core verification module (#3848/#3853)

The first two pieces of the #3848 four-piece plan for the kernel decision core:

1. **Sub-language guard** (`subset-guard.ts` + `guarded-files.ts` + `exceptions.ts`) — CI fails if any construct the translator cannot model is ever WRITTEN into a guarded file.
2. **TS→z3 symbolic executor MVP** (`symbolic.ts` + `replay.ts`) — translates a REAL function body from source into z3 constraints; solver counterexamples must replay through the real compiled code before they count.

Plus the invariant oracle (#3: structural tree comparison) and the long-range targets (#3676/#3691/#3769/#3805) — those are follow-ups on the #3848 route, not part of this kickoff.

## Sub-language guard

`tests/verif-subset-guard.test.ts` runs in every CI leg (`tests/*.test.ts` auto-collection). It scans the ten Tier A files listed in `guarded-files.ts` and fails when:

- a live violation has **no registered exception**, or
- a registered exception **matches nothing anymore** (stale inventory is itself a failure — the stock stays audited), or
- an exclusion points at a function that no longer exists, or
- the live-violation count ≠ registered-exception count (padding detection).

### Rules (all fail closed)

| Rule | Catches |
|---|---|
| `import-specifier` | non-relative imports, relative imports escaping `kernel/src`, missing targets, bare packages |
| `async` / `generator` | async functions, await, `*` functions, yield |
| `class` / `decorator` | any class or inheritance, decorators |
| `eval` | `eval`, `new Function`, dynamic `import()`, `require()` |
| `env-access` | `process.*`, `globalThis.*`, `global.*`, `import.meta` |
| `unknown-global` | identifier neither locally bound nor on `GLOBAL_ALLOWLIST` |
| `unwhitelisted-method` | method-call name outside `METHOD_ALLOWLIST` (suppressed when the chain root is already a flagged foreign global — one violation per construct) |
| `unwhitelisted-constructor` | `new X` with X outside `CONSTRUCTOR_ALLOWLIST` |
| `closure-escape` | a same-file closure returned, or passed around by identifier (named function declarations are structural and exempt — they stay visible and auditable) |

Allowlists are **evidence-based**: every entry exists in the current Tier A surface (the #3853 AST inventory). Adding an entry weakens the guard — justify it like an exception entry.

### Current inventory (audited, 1:1 with live violations)

Four exceptions + one excluded function, each with a reason in `exceptions.ts`:

- `ex-compress-date` — `Date.now()` createdAt stamp in `applySingleRange` (metadata only).
- `ex-compress-console` — `console.warn` config-validation warning in `processTurn` (output side channel).
- `ex-responses-env` — `process.env.ACP_REASONING_KEEP` operator toggle in `shouldDropAllReasoning`.
- `ex-compress-protectedfn` — pure predicate passed to `assignRefs` (immutable captures only).
- `exc-tokenize-bpe` — `createBpeTokenizer` body + lines 1–3 (optional BPE probe: dynamic require of `@anthropic-ai/tokenizer` with pure fallback).

Note on granularity: the owner's estimate for this state was "8 exceptions"; the implemented rule set is coarser (e.g. object-literal member closures and parameter-default arrows are allowed positions rather than exceptions). Fewer registered deviations is strictly stronger; the acceptance criterion is "Tier A green with every deviation explicitly justified", which holds at this smaller count.

## Symbolic executor MVP

`solveFunction(file, name)` parses the REAL source (TypeScript compiler API), collects module constants from the file (numeric literals incl. `_` separators, one level of const-to-const references), and translates the function body into z3 over `Int`.

Control flow uses **dynamic single assignment**: each variable keeps a list of `(value, condition)` pairs; reads fold them into ITE chains, assignments prepend under the current path condition, and each `if` conditions its branches on its predicate. Path count stays **linear in the number of ifs** — no enumeration (#3848's anti-explosion requirement).

### Soundness contract (read before trusting a result)

- **"No throw under φ" is SOUND** for loop-free bodies: a throw site's condition is exactly the conjunction of branch predicates on its path.
- **Throw-reachability witnesses may be OVER-approximated**: code after an early return/throw gets a weaker condition than reality. This is deliberate asymmetry — false witnesses are cheap to catch, missed throws are not. Hence the replay lock: **every witness is executed against the real compiled function; a non-reproducing witness is reported as `REPLAY MISMATCH` and means the lens distorted.** What gets verified is always the real code; the translator is just a lens.
- Anything outside the modeled shapes throws `UnsupportedShape` loudly. Silent approximation is forbidden by design.

### Modeled vs refused (MVP)

Modeled: integer arithmetic `+ - *`, comparisons, `=== !== < <= > >=`, `! && ||`, ternaries, `Number.isInteger(x)` (vacuous true — Int domain), `Math.min/max` (via ITE), `Math.round/floor/ceil` (identity on integers), parameters as fresh `Int` constants, module constants from source, JS numeric truthiness (`x !== 0`).

Refused loudly: loops (bounded unrolling is the next step), switch, `/` and `%` (JS float division needs a scaling decision first), string operations (`padStart`, templates, `String()` — opaque; current control-flow properties don't depend on them), regex (z3 `re.` theory is the next step), array/object literals and combinators (combinator inlining → symbolic message sequences is the next step), calls into other functions (inlining is the next step).

### First proof (this PR)

`kernel/src/refs.ts` `indexToRef`:

- in-bounds `[1, 9_999_999]` (bounds read from the source's own constants) → **UNSAT** (no throw reachable);
- out-of-bounds witness from the solver → **replayed on the real compiled function: RangeError confirmed**;
- drift control: the same translation with a corrupted boundary (`MAX_INDEX := 9_999_998`) emits a phantom witness that the real code rejects → **REPLAY MISMATCH caught**.

## Running

```bash
node --import tsx --test tests/verif-subset-guard.test.ts   # guard (~1s)
node --import tsx --test tests/verif-symbolic.test.ts       # proofs (~3s, z3 wasm)
```

z3-solver (wasm) is a devDependency; it runs identically on every CI OS leg. No production code is touched — the guard constrains only the ten listed files, and the executor only READS sources.
