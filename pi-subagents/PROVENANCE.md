# Provenance — in-repo vendor (#2384)

Migrated verbatim from https://github.com/ranxianglei/billion-context-pi-subagents at commit `d19481e` (master, 2026-10-08). Same author, same MIT license — no re-expression needed (unlike the acp-kernel AGPL audit; see `../kernel/PROVENANCE.md`).

**Why 0.1.2, not 0.1.1:** master carries one merged-but-unreleased fix beyond the last npm publish (`v0.1.1`): PR #7 `fix: settle-gate delegate completion notifications to honor late reads` (`src/delegate-tool.ts` + `tests/delegate-settle-notify.test.ts`), the fix for ranxianglei/billion-context#2301. The in-repo version starts at `0.1.2` to reflect that the source differs from the published `0.1.1`.

**What changed vs the standalone repo layout:**

- dropped the `pi.extensions` and `publishConfig` fields (standalone-publish surface; no release workflow for this artifact yet — if one is added later, restore them);
- `devDependencies` aligned to the host repo's actual toolchain (typescript ^5.5.0 / tsup ^8.0.0 / tsx ^4.0.0 / @types/node ^22) plus `typebox` (resolved at build time, inlined into `dist/index.js` by this component's own tsup config);
- `homepage`/`repository`/`bugs` point at the billion-context repo.

The old standalone repo stays frozen until the move has settled (same policy as `ranxianglei/acp-kernel` after #2092). Any change under `pi-subagents/src/**` must bump `version` here (CI-enforced, `pi-subagents-guard`).
