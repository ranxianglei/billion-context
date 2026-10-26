# reference/

On-demand reference material for **billion-context** development.

**These files are NOT auto-loaded into an agent session.** Only [`AGENTS.md`](../AGENTS.md)
is loaded every session. The split is deliberate and load-bearing:

- **`AGENTS.md`** keeps the hard rules, invariants, and decision-time constraints — the
  things every session must obey without looking anything up.
- **`reference/*.md`** holds the long procedures, file listings, and test/release/git
  mechanics — the things you need only when you actually do that task. Follow the inline
  `→ reference/…` pointers in `AGENTS.md`; don't guess at a procedure, open the file.

## Index

| File | Holds | Read it when you |
|------|-------|------------------|
| [architecture.md](architecture.md) | The file-by-file `src/` module map + orientation cheat-sheet | Adding/removing a module, or needing to find where a concern lives. Regenerate the map when it drifts. |
| [testing.md](testing.md) | Build commands, local install, E2E codex + image-billing + hermetic-registry (+ advisory-rollback) suites (env vars, phases, CI trigger list) | Running build/test/e2e or wiring a test. |
| [release.md](release.md) | Release process steps (incl. release-notes entry), one-click workflow internals, bugfix carve-out channel, standalone acp-kernel kernel releases (#2092), auto-update testing, no-op validation protocol | Preparing or reviewing a release, or cutting an emergency hotfix. |
| [git-pr.md](git-pr.md) | "Open a PR without `gh`" REST recipe; external-contributor PR mechanics; post-merge supplements | Opening a PR or handling a contributor's PR. |
| [env-vars.md](env-vars.md) | Environment Variable Discipline (#2030): category table, hard rules, precedence rationale | Deciding whether a knob may be an env var, or adding/changing one. |

> If you add a new reference file, add a row above and a pointer from the relevant
> `AGENTS.md` section. Keep `AGENTS.md` lean: if a block reads like a *procedure* or an
> *enumeration* rather than a *rule*, it belongs here.
