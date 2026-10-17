# Environment Variable Discipline (#2030)

> **Not auto-loaded.** On-demand reference material pulled out of `AGENTS.md`
> to keep the auto-loaded spec lean. The operative rule stays in
> [`AGENTS.md` §3](../AGENTS.md#environment-variable-discipline-2030);
> this file holds the category table, hard rules, and rationale.

Env vars are a **scarce surface**: every `BILI_*`/`ACP_*` variable is a
permanent knob a user must discover, document (CONFIGURATION.md en + zh), and
keep in sync. The default answer to "should this be an env var?" is **no** —
the config file (`~/.config/billion-context/billion-context.json`) exists
precisely so knobs don't bloat the environment. Precedence everywhere:
**env var > config file > built-in default**, resolved in exactly one place
(`src/knobs.ts`).

> **Lifecycle vs. existence.** This file governs whether a knob MAY be an env var.
> Whether an existing one is TEMPORARY (a cap / kill-switch / experiment with a
> release condition) is tracked in [`LIFECYCLE.md`](../LIFECYCLE.md) (#3249) —
> every `BILI_*` read in `src/` must be registered there; CI enforces it via
> `scripts/lifecycle-ledger-guard.mjs`.

## Where a knob lives

| Category | Home | Examples |
|----------|------|----------|
| Behavior tunables (timeouts, caps, modes, diagnostics) | config-file key resolved through `src/knobs.ts`; env stays the override tier | `network.*`, `persist.*`, `sessions.*`, `update.*`, `diagnostics.*`, `fakeCompletion.*`, `plugin.*` |
| Secrets / credentials | env only (never written to disk) | `BILI_LAUNCH_TOKEN`, `BILI_ENCRYPTION_KEY` |
| Per-process channels (written by another bili component at spawn) | env only + comment at the read site naming the writer | `BILI_MCP_PROXY`, `BILI_PARENT_PID`, `BILI_STRICT_PORT`, `BILI_OPENCODE_ACP_SPEC`, `BILI_LAUNCHER_MODEL_*`, `PI_ACP_DELEGATE_*` (child-delegate propagation, #2230; file tier = `pi.subagents`) |
| Host-side posture (read inside a third-party host process at bootstrap) | env only + comment at the read site | `BILLION_CONTEXT_PLUGIN*`, `BILI_NATIVE_*`, `BILI_RECLAIM_FETCH_PATCH` |
| Path relocation (test/container isolation) | env only via `src/paths.ts` | `BILI_CONFIG_FILE`, `BILI_SESSIONS_DIR`, `ACP_DUMP_DIR`, `XDG_*` |
| Third-party conventions (not ours to rename) | as-is | `CLAUDE_CODE_SESSION_ID`, `CODEX_HOME`, `https_proxy` |

## Hard rules

1. **New env var = new discussion.** A PR introducing a new `process.env.X`
   read that fits none of the env-only categories above is incomplete: the
   knob lands as a config-file key resolved through `src/knobs.ts`
   (env > file > default), or it carries explicit owner sign-off for the
   env-only category in the PR thread.
2. **One resolver per knob.** Tiered resolution lives ONLY in `src/knobs.ts`;
   leaf modules delegate and never parse `process.env` themselves. The env
   tier preserves each variable's historical parsing quirks byte-exact
   (backward compat); the file tier takes strict typed values. A
   set-but-garbage env value resolves exactly as it did pre-migration — it
   never leaks into, nor is shadowed by, the file tier.
3. **Env wins over file, always.** Test seams set env live after import;
   inverting the precedence breaks them.
4. **Document or don't ship.** Every user-facing knob (either tier) is
   documented in CONFIGURATION.md (en + zh) with its default and env-var
   name.

## Rationale (why this shape)

- **The migration that prompted this rule (#2030):** ~30 pure-behavior knobs
  were env-only with no config representation at all — unmanageable for
  users who want per-machine behavior without shell plumbing. They now live
  under the `network`/`persist`/`sessions`/`update`/`diagnostics`/
  `fakeCompletion` blocks (+ scalars, + `mitm.handshakeTimeoutMs`,
  `compat.noCacheControl`, `compat.keepResponseId`) with every default
  unchanged and every env var kept as the override tier.
- **Why env stays the top tier:** historical parsing quirks (truthy strings,
  negative opt-outs, `""` vs unset) are part of the deployed contract, and
  test seams mutate env live after import. The file tier is additive and
  strictly typed; it can never change what a running deployment already did
  with its env.
- **Why process-scoped, not three-level:** these knobs have no
  provider/model dimension (their env form was already process-global), so
  they sit at the config-file top level rather than inside the three-level
  `compress` hierarchy. `imageBilling`/`imageTokenCap`, which DO have
  provider/model tiers, remain in the providers table.
- **Precedence contract pinned by test:** `tests/knobs-config-precedence.test.ts`
   asserts env > file > default, set-garbage-env byte-exactness, and hot-reload
   of the file tier.

## Test-infra escape hatches (scripts/-only, never product knobs)

A small class of env vars exists purely for the local test harness — read by
`scripts/*`, NEVER by `src/` or `src/knobs.ts`, and therefore NOT config-file
knobs. They carry no provider/model dimension, are never shipped behavior, and
stay OUT of CONFIGURATION.md (that surface is for user-facing knobs). They are
documented HERE instead so the discipline ("document or don't ship") still
holds without polluting the product config surface.

| Var | Read by | Effect | Default |
|-----|---------|--------|---------|
| `BILI_TEST_FORCE` | `scripts/test-suite-lock.mjs` only | Set to `1`/`true`/`yes` to deliberately bypass the per-machine test-suite mutex (#3103) and let a second full `npm test` run share the machine with a live one. Untyped escape hatch for the known limitation the lock cannot cover (orphan daemons from a SIGKILLed suite, cross-clone contention); a normal single run never sets it. | unset = lock enforced |

`BILI_TEST_FORCE` is the escape door the suite lock points at when a sibling
run is detected (`[bili:test] a test suite is already running … to proceed
anyway: BILI_TEST_FORCE=1 npm test`). Because it changes nothing about a
single-run's behavior and is invisible to production code, it needs neither a
config tier nor owner-gated config-surface review — only this one-line entry.
