# Cache-Stability Theorems (#2149)

Machine-checked statements about the proxy's outbound-body assembly, proven in
Z3 over the byte-level model in `spec/*.smt2`. This is the **route-4 (model
specification)** lane of #2149: the theorems are proven over the *contract*,
and two mechanisms keep the contract honest against the code:

1. **Grounding tests** (`tests/cache-theorem.test.ts`, `[grounding:*]`): each
   spec axiom is pinned to the real code it abstracts (below).
2. **The #2144 billing suite** (`tests/cache-proof.test.ts`): real proxy + real
   kernel vs an ideal prefix-cache judge, byte-LCP assertions across six path
   classes — the code↔spec sync evidence at whole-body granularity.

## Trust boundary (read this first)

A theorem here says: **any assembly function whose components satisfy the spec
axioms has the stated byte property.** It does NOT by itself say "the shipped
TS code satisfies the axioms" — that direction is covered by (1)+(2), not by
the solver. This is the honest strength of route 4: cheapest cost, guarantee
bounded to the spec surface. Routes 1–3 (compiling the real pipeline into a
symex front-end) would remove the grounding gap entirely and are tracked as a
separate issue after this lane lands.

## Theorems

### T1 — growth stability (`t1-s1*`, `t1-s2*`)

For history `H`, message `m`, pipeline `f`: `f(H+[m])` and `f(H)` share a
common byte prefix of depth at least `D`, where `D` = envelope head + stable
content of the merge-anchor element. The statement is encoded with an explicit
shared-prefix term `P` (`blen(P) = D`) as `substr(body, 0, blen(P)) = P` for
both bodies -- a decidable strengthening of the quantified "exists p >= D"
form, which Z3's string solver returns `unknown` on. Everything after `D` may differ only at
the existentially quantified declared carrier positions:

- **MERGE family** — nudge/hint text appended to the last-user turn's content
  tail (`src/wire-body.ts appendTrailingUserText`; degenerate-retry;
  fake-completion). Two scenarios are instantiated: merge anchor *flips* to the
  new message (S1) and stays stationary (S2).
- **TAIL family** — trailing user element (imgNote conditional / chain
  checkpoint stamp / fresh-turn fallback): optional presence + free content per
  run; the checkpoint stamp carries the clock (`stampOutbound(nowMs)`) — the
  x-at-interface impurity, modeled as a free function of a free integer
  instantiated differently per run.

All other bytes (envelope, old elements, ref tags, separators, framing) are
shared subterms in both bodies ⇒ equal by congruence. Impure points (network,
session store, clock) are modeled as free functions/free inputs at the
interface per the owner stance — no pure extraction was needed; the surveyed
rebuild core has zero impure calls inside `kernel/src/rebuild.ts`.

### T2 — ref monotonicity / id-never-reused (`t2*`)

Bounded 4-step session over the real allocator rules
(`kernel/src/refs.ts assignRefs/allocateFreeRef`; archive op = #421
`applyCompactionArchive`): initial live map `{a→5, b→2, c→3}`, cursor 6; the
session HIGH (number 5) dies; archive prunes; two appends allocate.

- `t2-host.smt2` — **UNSAT**: with the persisted monotone cursor (grounded in
  `src/session.ts`: `state.nextIndex` carried verbatim; `cursor := n+1`;
  retire/archive never move it), no allocation reissues an ever-issued number,
  even though the high died. This is the machine-checked form of the host duty
  behind the kernel id-never-reused contract.
- `t2-mutation.smt2` — **SAT**: if the cursor is instead RECOMPUTED from the
  pruned map after the archive (`highestUsedIndex+1`, the documented #421
  residual), the solver produces the counterexample `n4 = 5` — the dead high
  number reissued. The residual window is thereby characterized exactly: it
  opens iff the cursor drops below a dead ever-issued number.
- `t2-claimcoupling.smt2` — **SAT** (#3198 hardening): if live-message ref
  presentation were gated on reconcile CLAIM state instead of the persistent
  content-keyed map, a byte-identical live message presents under different
  refs across consecutive turns (witness: turn A takes the map-lookup path →
  stored number 5; turn B the fresh-allocation path → ≥ cursor 6). Shipped code
  has no such coupling — `assignRefs` reads only the persistent map + persisted
  cursor ([grounding:g1]) and raw ids derive from message content
  ([grounding:g4]); this twin proves the theorem WOULD break if the coupling
  were introduced.

### Mutation discipline (acceptance criterion: proofs are not vacuous)

Each theorem has a mutation twin that injects a stable-region defect (a
same-length content rewrite strictly below `D` in T1 -- which byte changed is
existentially hidden at this abstraction level; the concrete byte surface is
#2144's job -- and the post-archive cursor reset in T2). The solver MUST find
each as a counterexample within the time budget; the T2 model exhibits exactly
`hui=3 creset=4 n3=4 n4=5` (the dead high reissued). A proof that cannot be
falsified by its own known-bad mutation is treated as broken, not merged.

T1 mutations are stated single-side (`substr(corruptedBody, 0, blen(P)) != P`):
sound because the uncorrupted side satisfies the property by its theorem file,
so one conjunct's failure IS the pair property's failure.

## Spec → code grounding map

| Spec axiom | Grounded by |
|---|---|
| `esc` E0/E1/E2/E3 (escaping algebra) | `[grounding:g3]` — homomorphism + injectivity of the inner JSON string encoder on 200 randomized BMP strings |
| `mktag` determinism/injectivity | `[grounding:g2]` — `indexToRef`/`refToIndex` round-trip + injectivity over 200k numbers |
| T2 allocation rules (floor, smallest-free-over-live, existing-untouched, BLOCKED-free, `cursor := n+1`) | `[grounding:g1]` — `assignRefs`/`allocateFreeRef`/`highestUsedIndex` on constructed maps, incl. the gap-below-cursor case |
| raw-id derivation (content-keyed determinism; cluster numbering pass-stable + prefix-invariant) | `[grounding:g4]` — `deriveMessageId`/`ClusterCounter` on constructed inputs |
| envelope/framing bytes (`hdr`/`ftr`/`fpre`/`fmid`/`fpost`/`SEP`) | `tests/cache-proof.test.ts` (#2144) — byte-LCP unexplainedDivergences=0 across four wires and six path classes |
| carrier anchor placement (merge-last-user / tail-append, optionality) | #2144 scenario matrix + call-site survey recorded in `spec/t1-*.smt2` headers |

## Running

```bash
# needs z3: CLI on PATH, or python3 with the z3 module (pip install z3-solver==4.9.1.0)
node --import tsx --test tests/cache-theorem.test.ts
```

Ten solver obligations (two context-sanity SAT guards per scenario family,
which catch vacuous proofs if the context ever becomes inconsistent; two
growth-stability UNSAT theorems; two T1 mutations; one T2 theorem; two T2
mutations) plus four grounding test groups. Without a solver installed, solver
subtests skip individually and grounding still runs, so the main suite stays
green; CI runs the `.github/workflows/ci-theorem.yml` lane (ubuntu, pinned
`z3-solver==4.9.1.0`, paths-filtered to the assembly surface) so every relevant
PR gets the verdicts. All nine resolve in well under a second total.

Solver compatibility notes (learned the hard way):

- Bytes are modeled as the SMT-LIB **String** theory (`str.++`/`str.len`/
  `str.substr`), not sequences of bitvectors -- this parser rejects
  `(_ Seq (_ BitVec 8))` sorts outright.
- No obligation context carries quantifiers or array terms. A quantified axiom
  over a String-typed function (the old `mktag` injectivity) poisons SAT-mode
  model building in this build (every mutation check went `unknown` with it
  present, instant without); the `esc` algebra lives in
  `spec/esc-axioms.smt2`, outside every obligation, since the proofs are
  congruence arguments that never instantiate it.
- Verified on both Z3 4.9.1.0 (native, the CI pin) and 4.16.0.0 (WASM,
  local iteration): identical verdicts and models.

## Known limitations (honest scope)

- Bounded instantiations: fixed role shapes (S1/S2), 4-step T2 session. The
  general schema is the same equations at arbitrary N; extending N is mechanical
  but not yet parameterized in SMT2.
- `esc` length bounds use worst-case ×6 (JSON `\uXXXX`); the real encoder is
  tighter — the bound only constrains, never enables, a wrong conclusion here.
- Frame/envelope functions stay uninterpreted: their *placement* (content right
  after `fpre`, separator discipline, carrier slots) is the load-bearing part
  and IS asserted; their exact byte content is delegated to the #2144 suite.
- Stronger decompositional form of T1 (explicit `bodyA = P ++ CA ++ M1` split
  witnesses with per-carrier offsets) is future work; the current explicit-P
  prefix form already matches the issue's statement (prefix equality outside
  the existentially quantified carrier positions).
