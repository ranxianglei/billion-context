# billion-context Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**
>
> **How to read this:** the rules and invariants below are loaded every session and are the operative contract. Long procedures, file listings, and test/release/git mechanics live in [`reference/`](reference/) and are **not** auto-loaded — follow the inline `→ reference/…` pointers when you hit that task; don't guess at a procedure, open the file.

## 1. Project Overview

**billion-context** is an npm package (`bili` CLI) — a context-compression proxy for AI agents. It sits between an agent client and an upstream LLM provider, injecting acp-kernel's compression pipeline to manage context growth.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling; inlines the in-repo kernel `kernel/`) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Dep | the in-repo compression kernel (`kernel/`, npm name `acp-kernel`, bundled inline at build time) + `zod` (external, only used by `dist/agent/opencode-native.js` V1 tools; `dist/index.js` stays dependency-free) |

### Repository Info

| Field | Value |
|-------|-------|
| npm package | `billion-context` |
| CLI | `bili` / `bili-proxy` |
| GitHub | https://github.com/ranxianglei/billion-context |
| License | MIT |

## 2. Architecture

### Module Map

The full file-by-file map lives in [reference/architecture.md](reference/architecture.md) — it drifts as modules land, so **regenerate it when you add/remove a source file; don't trust a stale copy**. Orientation at a glance: `src/server.ts` (+ `src/loop/**` adapters) is the request pipeline; `src/update.ts` is the load-bearing self-updater; `src/persist.ts` + `src/session-id.ts` own persistence/identity; `tests/e2e/` holds the real-client regression suites; the compression engine itself lives in-repo under `kernel/` (the acp-kernel source, #2092).

### Key Design Decisions

1. **The in-repo kernel is bundled inline** — `kernel/` (the acp-kernel source, consumed as a `file:` devDependency, #2092) is NOT listed in tsup `external`, so `dist/index.js` is self-contained. Exception: `zod` (exact `4.1.8`, matching the opencode host's own zod so V1 plugin-tool shapes interoperate) is a real dependency and stays external — only `dist/agent/opencode-native.js` imports it (lazily, at plugin-tool registration); `dist/index.js` and every other entry remain zod-free. When zod cannot be resolved at runtime the V1 plugin degrades to plain proxy mode instead of failing.
2. **Tags use XML format** — messages carry ACP tags like `<acp tokens="2" type="text">m00001</acp>` (an opening element with `tokens=`/`type=` attributes wrapping a ref id, closed by its end element). In **source files** these angle brackets MUST be written as hex escapes (`\x3c`, `\x3e`) to avoid tooling that strips well-formed tags.
3. **Auto-update**: checks npm registry every 3 min by default (`CHECK_INTERVAL_MS = 3*60*1000`, overridable via `update.checkIntervalMs` / `BILI_UPDATE_CHECK_INTERVAL_MS`, #2030); first check per process ignores throttle.
4. **Tee logger**: all proxy logs go through `src/logger.ts` (file + stderr). Do NOT use `console.error` in server-side modules — use `loggerLog()`.
5. **The kernel lives in-repo; determinism comes from git, not a registry pin (#2092).** The acp-kernel source is vendored under `kernel/` and consumed via `"acp-kernel": "file:./kernel"` (devDependency; inlined into `dist` at build time). A commit IS the pin — there is no registry range left to drift. The kernel keeps its OWN version in `kernel/package.json`: any kernel source change MUST bump it (CI-enforced — see Kernel Boundary below), so accumulated changes can later ship as an independent npm release of `acp-kernel`. `package-lock.json` records the file link and stays committed.
6. **Single-writer plugin copies (#991)** — every bili presence has exactly ONE writer; mixing writers is what the guard forbids. The canonical statement is the Install-Lane & Update-Ownership Contract below.
7. **Two compression modes with different summary carriers** (CRITICAL — reason in BOTH, see §6):
   - **pluginMode** (the `x-bili-plugin` header / registered agent, e.g. `bili pi`): the ACP-native agent OWNS compression — it executes `compress` locally, the call+result live in its own re-sent history, and the wire summary carrier is the **tool call** (the proxy suppresses tool injection; the nudge is still injected in BOTH modes as an ephemeral trailing user message — the agent has no nudge channel of its own, #451; the agent's view never renders the kernel's `acp_summary`).
   - **proxy mode** (plain client, no header): the proxy executes `compress` server-side; the tool call is ephemeral (never enters the client's history) and preflight blocks have none, so the carrier is the **`acp_summary` message** — the kernel renders it role `system`, but `systemToUser` (`src/util.ts`) re-voices it as a **`user` message** (leaving it at its anchor) so strict backends (SGLang: exactly one system at index 0, #377) accept it and the head system message stays byte-stable for the prefix cache.
   - The mode is decided per request and bound per session (`session.metadata.pluginAgent`, sticky, upgrade-only). See TECHNICAL-NOTES.md "Two compression modes".
8. **Nudge cadence is flat 50K by design (kernel contract)** — acp-kernel pins the growth interval at 50000 for every window size (`nudge.growthFloor == nudge.growthCap == 50000`; window-percentage scaling was deliberately removed — #379/#380 settled "growth-driven, no usage/count proxy gates"). Do NOT re-scale the interval with the context window or reintroduce percentage gates; a 1M-window session folding every 50K of growth is intended lean-context behavior. User escape hatch: `compress.nudgeGrowthTokens` (flattens `growthFloor`+`growthCap` to a fixed step) — big-window users who want a lazier cadence set it explicitly. Prompt wording is kernel-owned (`src/nudge-text.ts`).
9. **Hosts that reuse ONE session id across personas get id + system-hash session keys ("hash 不一样自动分裂")** — when a plugin host stamps the SAME conversation id on every model request of a session INCLUDING auxiliary personas (dsh auto-review `classifyRisk()`: fixed REVIEW_POLICY system + a fresh flattened blob before every tool call — #1916/#1307/#1314), those auxiliary requests must be keyed by `subagentNamespace(id, systemText)` so the persona forks onto its own `<id>|sub:<fp>` session instead of overwriting the main session's baseline/snapshots. The FIRST system seen under the id keeps the raw key (kernel anchor), so main turns never fork; an empty system is non-anchoring (verbatim); SIDE REQUESTS never claim the anchor either — dsh's title-gen sidecar fires at session start before/concurrent with the first main turn, and claiming it would fork the whole main conversation onto `|sub:<fp>` while every host-stamped ACP management call (compress/decompress/acp_status) routes into the ghost's empty session and fails forever (#2156/#2160; the `sideRequestLike` gate in `src/server.ts` mirrors the #388 passthrough predicate). This is an EVIDENCE-PERMITLIST (`dshPersonaFingerprintApplies` in `src/session-id.ts`), the same discipline as the instructions fingerprint (#1104/#1107): do NOT enable it wholesale — for everyone else system drift mid-id means "same conversation, evolved", and forking resets compression for no defending bug (#1106). A future host found reusing session ids across personas gets added to that predicate WITH traffic evidence (shape + stability proof: the host's main system must be session-stable, e.g. dsh composes it once per session and puts volatile time-context in a USER message). The fork must record itself under its suffixed id (`personaForked` → `recordPluginSession`) so the single-valued conversations map keeps the raw key owned by the main session (#970 discipline). Tests: `tests/dsh-persona-fingerprint.test.ts`.

10. **Thinking-family blocks are signature-verified — NEVER rewrite them (#1960)** — Anthropic `thinking`/`redacted_thinking` blocks and Gemini `thoughtSignature` parts are verified byte-for-byte when the latest assistant message is replayed ("thinking blocks ... cannot be modified"). The bytes the proxy forwards become the client's persisted history, and the bytes the loop accumulates become the re-request rebuild — BOTH must stay verbatim. Any transformation (tag/marker stripping, dedup, trimming, re-laying-out block order, dropping empty segments) desynchronizes text from signature and bricks the session: first on the in-turn re-request, then on every subsequent request via the client's echo. #1882 put a prose filter on the thinking channel and it was exactly this bug. Treat ANY future change touching thinking-family payloads as high-risk: it needs loop-level byte-equality tests (re-request body AND client-visible stream) on both signed wires, not just adapter-level ones. The prose filters (#206/#1881) are for the TEXT channel only.

### Install-Lane & Update-Ownership Contract (#1196)

Every bili presence on a machine follows ONE contract — decide changes against it, not ad hoc:

1. **One writer per copy, chosen by the install SOURCE.** A copy installed through a host's own channel (dsh plugin market, opencode/pi managers, pnpm store) is owned by that host: bili NEVER writes it in place (#991, `hostManagedInstall`). `bili plugin install <agent>` only ever DRIVES the host's channel (e.g. `dsh plugin add`), never installs a second bili-owned copy beside it (#966).
2. **Every copy must have a LIVE update path** — the actual fix for the "frozen forever" bug class (#1196). Exactly one of:
   - it IS the global install (npm `i -g`): self-updates in place;
   - it is a reference lane (omp/claude/codex/kimi/zcode/hermes entries): no copy at all, points at the global dist, follows it automatically;
   - it lives in a host world (dsh profile bundle, opencode/pi tree): updated through the HOST's channel — driven by a global self-update AND, when no global ever runs (market-only users), by the copy's own periodic check (`refreshDshProfileCopy`, #1196). Self-heal goes THROUGH the owner's sanctioned channel, never around it.
3. **Terminal users get the one-copy experience via launchers** (`bili dsh` overlay mode loads the global dist, no persistent copy); market users get self-contained per-context copies. Both are first-class; the user picks by entry point, and the two modes never mix for one lane (duplicate `bili-native` loader ids hard-fail dsh boot).
4. **Local pins stay manual.** `link:`/`file:` dev pins are never refreshed (`isRegistryDepSpec` gate) — dev lanes track a live checkout by design.
5. **Transient drift is acceptable and bounded**: lanes converge to the registry version within one check cycle (~3 min) plus a host restart. Permanent divergence is a bug — file it under this contract.

Machine-global facilities stay SHARED across all copies (deliberately): `~/.local/state/billion-context/` (log + sessions, #394 multi-instance warning), `~/.cache/billion-context/` (update throttle + cross-process update lock), `~/.config/billion-context/` (providers/compress config).

### Kernel Contract: Message Ids Are Never Reused

The kernel (`acp-kernel`) guarantees, and billion-context RELIES on: within a session, a raw content-hash id and a ref number (`mNNNNN`) denote exactly one message forever — **never reused, never duplicated**, even after the message dies (edited/truncated/folded). The model can cite any number it has ever seen (summaries cite tags across turns), so a re-issued number silently misattributes on decompress. Consequences for this repo:

- Host code must NOT prune/repack `session.state.messageRefs` in ways that let a freed number be re-issued (kernel `assignRefsNode` computes its cursor as `highestUsedIndex(map)+1`, so shrinking the map can drop the cursor and re-issue numbers).
- Known residual: `applyCompactionArchive` (#421, `src/session.ts`) prunes `byRaw/byRef` to live raw ids on native-compaction boundaries. In practice the highest-numbered (newest) messages stay resident so the cursor does not drop, but this is a theoretical re-issue window — drop the map-prune once the kernel's ref-space widening (post-#191 direction) makes it unnecessary.
- The kernel source lives in `kernel/` (#2092); its version at migration was 0.0.101 — the old registry-pin guards are obsolete (see Kernel Boundary below).

## Kernel Boundary (in-repo acp-kernel, #2092)

The compression kernel lives IN THIS REPO under `kernel/` (migrated verbatim from ranxianglei/acp-kernel @ v0.0.101 on 2026-10-04; the old repo stays frozen until the move has settled). It keeps its own identity — npm name `acp-kernel`, own `version`, own unit suite (`kernel/tests/`), own build chain (tsup → `kernel/dist` + d.ts) — and the host consumes it through `"acp-kernel": "file:./kernel"` exactly like the old registry package (same exports map, same typing, same JS inlined by tsup). The merge exists to end cross-repo maintenance pain WITHOUT making the kernel easy to disturb. Enforced rules:

1. **Declare before you touch.** Every PR touching anything under `kernel/**` MUST declare `kernel-change: <reason>` in its body (CI job `kernel-guard` fails otherwise) AND needs owner approval BEFORE implementation, via a dedicated issue stating why the host side cannot solve the problem. Commits use the `kernel:` prefix.
2. **Version discipline (CI-enforced).** Any change under `kernel/src/**` (or `kernel/tsup.config.ts` / `kernel/tsconfig.json`) MUST bump `version` in `kernel/package.json`; a bump without such a change also fails. Normal kernel changes ride along with billion-context releases; when enough accumulates, a dedicated kernel release publishes `acp-kernel` standalone (§5, Kernel releases).
3. **Human-only review, always.** ALL kernel changes sit at the same review tier as `src/update.ts` and security (§7.4): no auto-merge, ever.
4. **Behavior constants are golden-pinned.** `tests/golden/wire-contract/kernel.json` pins not just the tool schemas but the behavior surface hosts silently depend on: `defaultConfig(100_000)` (incl. the flat-50K nudge constants), `defaultPrompts` (the four load-bearing prompt rules), tool-name tables, wire markers. Regeneration requires stated justification in the PR; the ledger never shrinks (#1304).
5. **Two test layers, both must pass.** The kernel's own unit suite (`npm --prefix kernel test` — runs against TS source) plus the bili suite/e2e as the integration layer. A kernel change is done only when BOTH are green on the rebased head.
6. **Structural invariants stay human-gated** (carried over from the kernel's own spec): zero runtime deps (no new dependency without owner sign-off), platform-agnostic core (no host API / file I/O / network), message-id immutability, wire-artifact format, lossless round-trip, protected-tool hard exclusion, canonical pipeline node ordering.

## 3. Development Standards

### Build Commands

```bash
npm run build          # builds kernel/ first, then tsup bundle (kernel inlined)
npm run typecheck      # tsc --noEmit --project tsconfig.json (src + tests; pre-hooks build kernel/)
npm test               # node --import tsx --test tests/*.test.ts (bili suite; kernel suite: npm --prefix kernel test)
```

### Local Testing & Install

Test against the REAL published artifact: `npm run build && npm install -g billion-context@latest && bili start --port 8787`. `npm install -g . --install-links` also works, but `--install-links` is REQUIRED on npm ≥ 9 (without it the global install is a SYMLINK to the dev tree — leaks edits and silently re-links on reinstall, #1225). Verify: `readlink $(npm root -g)/billion-context` — empty = real copy. Full recipe: [reference/testing.md](reference/testing.md).

### E2E Regression (real client through bili)

The suites below cover the full context lifecycle plus the hermetic billing/advisory lanes — the real-client ones are the only coverage that exercises real client behavior (UA, wire quirks, retry loops):

- `tests/e2e/e2e-codex.test.ts` — real `codex` CLI through a Responses-compatible upstream (warmup → growth → ACP compress → purity → native-compact). Skips by default behind `ACP_TEST_E2E=1`; **never remove the gate**.
- `tests/e2e/e2e-image-billing.test.ts` (`npm run test:e2e:image`) — hermetic real-image billing lane (#1843/#1857): deterministic image corpus driven through the real billing pipeline against a mock upstream; ungated, ~1s, always runs in CI (`.github/workflows/ci-image.yml`).
- `tests/e2e/e2e-registry.test.ts` — hermetic local verdaccio exercising the real self-update chain; `tests/e2e/e2e-advisory-rollback.test.ts` shares its gate and fixture infra, asserting the #1588 rollback-form advisory contract end-to-end. Gated by `ACP_TEST_REGISTRY=1`.
- Newer hermetic lanes each carry their own skip gate (read the test header for the exact env var): release-canary (`ACP_TEST_CANARY=1`), OpenCode V2 Responses-over-WebSocket (`ACP_TEST_E2E_OC_WS=1`, needs a real OpenCode V2 binary), plus real-client native suites under `tests/e2e/` (dsh/opencode/pi/codex-fake/subagent-sessions).

Rules: run the codex suite (at least the 4-phase core) before merging changes to the request pipeline (`src/server.ts`, `src/loop/**`, adapters, preflight/compact paths); run the registry suite before changing `src/update.ts`, `src/advisory.ts`, or `src/plugin-install.ts`. Exact env vars, phases, and the CI trigger file-list: [reference/testing.md](reference/testing.md).

### Configuration Surface Discipline (owner-gated)

The config surface — every field of `~/.config/billion-context/billion-context.json`, every `BILI_*` env var, every CLI flag, mirrored across CONFIGURATION.md en/zh — is **owner-design territory**. Hard rules:

1. **Any change that adds, renames, or re-semantics a config field MUST report it explicitly** in the PR under a "config surface" heading: what is added/changed, why the existing surface cannot express it, which existing mechanisms were considered (providers table + its key species, the three-level `compress` hierarchy, env-var conventions, launcher↔extension channels), and the compat/migration story. A PR touching config without this section is incomplete by definition.
2. **Agents do NOT invent new config shapes on their own initiative.** A new section/field proposed merely because locally convenient — without mapping it onto the existing system — is rejected on principle: **don't even build it**. File the proposal (issue, with the mapping above) and wait.
3. **The only exception is explicit owner sign-off in the issue/PR thread, given BEFORE implementation**, recorded alongside the design rationale. "The agent thought it was a good idea" is never sufficient reason.

Canonical cautionary case (#1437 → #1469): a one-off `plugin.nonHttpProviders` section drafted alongside the existing `providers` table collided with the table's design and had to be reworked into `providers[<name>].compactionOptIn`. The first shape should never have existed.

### Environment Variable Discipline (#2030)

Env vars are a **scarce surface**: by default a new behavior knob becomes a config-file key resolved through `src/knobs.ts` (**env > file > default**) — not a new `process.env` read. Env-only is reserved for six categories (secrets, per-process spawn channels, host-side posture, path relocation, third-party conventions); every env var must be documented in CONFIGURATION.md en+zh ("document or don't ship"). Full category table, hard rules, and rationale: [reference/env-vars.md](reference/env-vars.md).

### Code Quality

- **No `as any`**, **No `@ts-ignore`**
- **No comments unless absolutely necessary**
- Hex escapes required for any ACP-tag XML in source files (see KDD #2)
- **No `console.error` in server-side modules** — use `loggerLog(level, msg)` from `src/logger.ts`. Exceptions: `src/cli.ts` (user-facing CLI errors) and `src/index.ts` (pre-logger startup crash).

## 4. Git Safety Rules (MANDATORY)

| Rule | Enforcement |
|------|-------------|
| **NEVER force-push to `master`** | Under no circumstances (GitHub branch protection also blocks it). |
| **NEVER merge PRs** | Human-only. If asked to merge, reply: "I can't merge PRs — AGENTS.md forbids Agents from merging. Please merge yourself: [PR URL]." |
| **NEVER run `npm publish`** | CI handles it on release-PR merge. Never manually — incl. `NPM_ALLOW_DANGEROUS=1` or `npm pack` workarounds. If asked, reply: "I can't publish to npm — releases publish automatically via CI. See §5." |
| **NEVER print the GitHub PAT** | Token stays in a shell variable only. |
| **Branch naming** | `YYYY-MM-DD_short-title`; releases: `*_release-v*` (bili) / `*_release-kernel-v*` (kernel, §5) |
| **NEVER modify `version` off release branches** | `"version"` touched ONLY on `*_release-v*` branches. Content commits must NEVER bump it. See Version Bumps below. |

**Opening a PR** (no `gh` CLI — push + credential helper + GitHub REST API): the full token/curl recipe is in [reference/git-pr.md](reference/git-pr.md). Summary: `git push origin HEAD`, extract the token from `git credential fill` (shell var only, never print), POST to `/repos/ranxianglei/billion-context/pulls` with base `master`. Merging stays human-only.

**External contributors' PRs — fix directly, don't replace.** Per the owner rule (小问题直接修, 2026-10-01), fixes are pushed as **additive commits to the contributor's PR branch**, whoever authored the PR — same as any other branch. What stays off-limits is REPLACING the contribution: no rebase-and-replace with an Agent-owned PR, no closing a still-mergeable contribution in favor of a new one (#1765) — the contributor's commits, diff and authorship stay in the merged history. Before assuming it's broken: a deleted head branch does NOT kill an open PR (GitHub freezes `refs/pull/N/head`; check `mergeable`/`mergeStateStatus` first), and `BEHIND` is not a blocker. Mechanics: [reference/git-pr.md](reference/git-pr.md).

**Post-merge supplements** → a small follow-up PR whose body references the original PR number; never append to / rebase the merged PR. Verify a supplement is actually needed first (replaying the same commit on newer master is verification, not content).

### Issue & Problem Tracking (MANDATORY)

One issue = one scope; open a PR, never just push a branch; never bundle unrelated changes or mass whitespace/reformatting into a fix. When an Agent works an issue, deliverables are mandatory:

1. **Finished development → PR.** Open a PR referencing the CURRENT issue (`Closes #N`) and reply in-thread with the PR link. An issue is never "done" without a PR.
2. **Problems DISCOVERED while working** (bug / data-loss / security / architectural) → report in the current thread AND file a separate new issue (repro, impact, suggested fix) in the project the problem belongs to.
3. **Problems FIXED** → leave a trace: an issue recording the problem + how it was fixed; if shipped as a PR, the PR references its issue (`Fixes #N`). A bare PR without an issue is not acceptable — file the issue first, then link it.
4. **Minor problems → fix directly（小问题直接修）** (owner rule, 2026-10-01): small issues (typos, cosmetic defects, indentation/log-wording quirks, minor UX wrinkles) found while working — including during a PR review — are fixed RIGHT AWAY in the same branch (a tiny follow-up commit on the PR's own branch is fine), with a one-line note in the thread. Do NOT open separate issues for them, and do NOT leave them as "noted, not fixed". Applies to ANY branch, including external contributors' PR branches.

Split extra findings into their own issues/PRs rather than expanding this one's scope.

### Version Bumps — One Version, One Commit, One Branch

`"version"` in `package.json` is the single source of truth for what gets published. Touched by the standard release flow ONLY (§5). Two hard rules:

1. **`version` changes ONLY on release branches** (`*_release-v*`). Feature/fix/refactor/docs commits leave it untouched — if you find yourself editing it on a content branch, **stop**, you're on the wrong branch.
2. **A release commit changes ONLY `version`** (+ `package-lock.json` if it drifts). Never bundle a bump into a content commit or content into a release commit. One bump = one isolated commit `release v{VERSION}`.

**Why load-bearing:** CI (`release.yml`) detects a release by matching branch name AND commit message; bundling breaks the trigger and causes 3-way conflicts on `package.json`. If asked to "just bump the version" inside a feature change, decline and route it through §5.

## 5. Release Workflow

Releases are fully automated via CI (`.github/workflows/release.yml`): the Agent prepares a release PR; merging it builds, tests, publishes to npm, tags, and creates a GitHub Release. Kernel releases (`acp-kernel`) use the parallel flow in `.github/workflows/release-kernel.yml` (below). There's also a one-click fast path for routine patches. Hard rules (exact steps + internals in [reference/release.md](reference/release.md)):

- **Branch** `YYYY-MM-DD_release-v{VERSION}`; commit `release v{VERSION}` changing ONLY `version`. The Agent does steps 1–6 (sync master → branch → bump → **release-notes entry if severe (#1870)** → pre-flight typecheck+test+build → commit/push/open PR); HUMAN merges step 7; CI publishes step 8.
- **Release-notes entry (#1870, OPT-IN since 2026-10-04):** only SEVERE releases need an entry in `release-notes/package.json`; ordinary releases ship with NO entry (the gates log a notice and pass when absent, validate when present). Add a severe entry as its own commit in the SAME release PR; the one-click fast path needs it already merged to master before dispatching. Full rules: [reference/release.md](reference/release.md) + `release-notes/README.md`.
- **Bugfix carve-out channel (#2011):** emergency hotfixes ship through `.github/workflows/release-bugfix.yml` (dispatch-triggered, no release branch) — mechanics and constraints: [reference/release.md](reference/release.md).
- **NEVER run `npm publish` manually** — CI does it (§4).
- **Kernel releases (separate artifact, #2092).** `acp-kernel` can be published standalone from this repo when accumulated kernel changes warrant it: branch `YYYY-MM-DD_release-kernel-v{VERSION}`, commit `release kernel v{VERSION}` changing ONLY the version in `kernel/package.json`. Merging runs `.github/workflows/release-kernel.yml`: full bili gate + kernel suite, publish `acp-kernel` to npm, tag `kernel-v{VERSION}` (separate tag namespace — bili tags stay bare `v*`), GitHub Release. No release-notes entry required (different artifact; the PR body serves as notes). The two branch patterns are mutually exclusive, so bili's and kernel's release flows never cross-trigger. Downstream consumers of the npm package update as usual — zero notice needed.
- **Changing `src/update.ts` (the updater itself) requires a NO-OP validation release FIRST** — a pure version bump proves the *existing* upgrade path is healthy end-to-end before the change ships. A broken updater bricks every future upgrade. Full protocol + rationale: [reference/release.md](reference/release.md).

## 6. Contributing

Before changes: (1) `npm run typecheck` clean, (2) `npm test` green, (3) understand the module dependency graph, (4) **consider BOTH compression modes** — any change touching the wire (message rebuild, system/developer handling, tool injection, `acp_summary` stripping, preflight, nudge) must be reasoned in BOTH plugin mode and proxy mode; correct-in-one-mode can break the other (#377 only manifested in proxy mode). See TECHNICAL-NOTES.md "Two compression modes" and the `pluginMode` comment in `src/server.ts`. (5) **Kernel changes follow the Kernel Boundary** — declaration marker, owner approval, version discipline, two-layer tests; the kernel is relatively stable by design, touch it only when necessary.

Commit convention: `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `release:`.

## 7. Review & Auto-Merge Discipline

> Distilled from a full-history review of AI auto-dev across billion-context / billion-context-pi / acp-kernel (#801). Goal: ~90% of bugfixes mergeable without rework, without drifting off direction. Evidence appendix (baseline data, per-issue provenance, second-round analysis): [AUTO-MERGE-GUARDRAILS.md](AUTO-MERGE-GUARDRAILS.md) — the authoritative OPERATIVE rule text stays here in §7.

### 7.1 Before You Start

- **Duplicate screening first.** Search open AND closed issues/PRs for the same fix before implementing; if one exists, link it — don't start parallel work.
- **One issue = one scope.** Split extra findings into separate issues/PRs; never bundle unrelated changes or mass whitespace/reformatting.
- **Open a PR, never just push a branch.** A bare branch is not a deliverable.

### 7.2 Review Discipline

- **Rebase to CURRENT master before claiming mergeable.** Verify against live master, not the PR's original base; after rebase re-run typecheck + full suite + build. Stale base is the #1 cause of second-round rework (#425 Aug-31 base, #467 43 commits behind, #517).
- **Watch hot-file contention.** `src/server.ts`, the preflight paths, `src/persist.ts`, and the `src/agent/*` extension types are rewritten by many concurrent PRs — expect semantic (not textual) conflicts; coordinate/sequence, resolve by union of intent, then prove by running tests (#517↔#587, #571↔#558).
- **One linear commit, clean diff.** No diff-exploding rebases, no incidental whitespace re-alignment; every line relates to the PR's purpose (#571 "diff-爆炸", #467).
- **Minor flaws found during review get fixed, not filed.** Per the owner rule "小问题直接修" (§4 Issue & Problem Tracking): when your own review of a PR turns up a small, non-semantic flaw (typo, misaligned indent, log wording), push the one-line fix to the PR branch immediately instead of listing it as a caveat — on ANY PR branch, external contributors included.
- **Done = evidence, not "should work".** Double-review, then RUN the changed behavior and observe it matches expectation; for context/wire fixes prefer a real e2e A/B against the issue repro over unit tests alone (#254).
- **Tests must be deterministic.** No environmental luck (e.g. assuming a port range is free — Windows' ephemeral range 49152–65535 collides with fixed picks; request a port via `listen(0)` instead, #360).

### 7.3 Correctness Guardrails

- **Root cause, not symptom (疏, not 堵 — first principle for every fix).** A fix removes the mechanism that PRODUCES the defect; it never merely hides the defect's visible trace at whatever layer is cheapest to intercept. Before writing any fix, name the producer of the offending bytes/behavior and fix it at the source or decision point — never by rewriting or filtering payload in transit to make the symptom invisible. Litmus test: "if the same root cause surfaced in a different shape tomorrow, would this fix still hold?" If not, it is a mask, and a mask is a latent bug. Canonical failure: #933 (model-echoed render tags leaking into a TUI) was "fixed" by stripping tool-call arguments mid-stream; the mask itself became #1039's silent data corruption once users legitimately wrote tag-shaped payloads through write/edit/bash. When the true root cause is out of scope (another repo, a product decision), fix the in-scope part, leave a documented boundary note pointing at the real home of the fix, and do NOT compensate in the wrong layer (#1039's echo-noise belongs on the injection side — host renderTags policy — not on the wire).
- **Never silently clobber or drop user config.** Any read-modify-write on user config needs a parse-state guard; reject malformed input loudly (HTTP 400/409) instead of merging into defaults or dropping fields. Whitelists must be complete (#155: a missing key silently erased custom compress prompts).
- **Sane defaults & fallbacks.** Fallback values must be reasonable (never a too-small value that thrashes); a static/fallback source must always lose to a fresher authoritative source when both are cheaply available (#282: window fallback 200K/min 100K, not 64K; the bundled registry snapshot must not outrank the live registry).
- **Prefer native stable identifiers.** Use a client's native stable session id when available (survives credential/model/provider switches); report clients that expose none; never build identity from derived hashes that drift on switch (#280).
- **Wire fidelity (host-side duty).** Never alter upstream protocol shape beyond intended injection: preserve tool_call ids/ordering, SSE structure, and upstream invariants (e.g. `compaction_trigger` must remain the last input item, #283/#209). Reason in BOTH compression modes (§6).
  - *Tool-call arguments are user intent (#1039).* Any payload a host will EXECUTE or PERSIST — tool-call `arguments` in every wire shape (OpenAI `tool_calls[].function.arguments`, Anthropic `input_json_delta.partial_json` / `tool_use.input`, Responses `function_call_arguments.*`), fragment or whole — is forwarded **byte-exact**. NEVER filter, strip, or "clean" it, not even to remove model-echoed render tags: a shape-based filter cannot distinguish an echo from a literal the user genuinely wants written (bash command strings, write/edit file contents), so any such "fix" silently corrupts executed/persisted data. Echoed tags surfacing in a host TUI is cosmetic noise — the fix belongs on the injection side (host renderTags policy, #933), never in the argument path. Tag-echo stripping applies to model PROSE only (content/reasoning/thinking/summary text fields); see the invariant block atop `src/loop/tag-echo-filter.ts`.
  - *Kernel-owned split:* the FORMAT CONTRACT of the kernel-emitted ACP artifacts (the compression tags, block refs, `acp_summary` structure — KDD #2) and the **id-never-reused guarantee** belong to **acp-kernel**, not this repo (§2 Kernel Contract). This repo only consumes them faithfully. Codifying the kernel-side spec is a change under `kernel/` — human-gated per the Kernel Boundary.
- **Symptom ≠ mechanism.** Before attributing a bug to bili's mechanism, verify against upstream logs — repeated-compression logs may be an upstream rate-limit retry illusion, not over-compression (#282).
- **Wire-constraint ledger only grows (#1304).** Every upstream rejection or validation constraint discovered in production or provider docs (e.g. #1299: Anthropic rejects top-level `oneOf`/`allOf`/`anyOf` in `tools[].input_schema`) becomes a PERMANENT entry in the wire-contract suite — the ledger (`WIRE_RULES`, defined in `tests/wire-contract-fakes.ts`) plus the gates in `tests/wire-contract.test.ts` (with provenance citing where the constraint was learned) plus enforcement in the matching validation-parity fake upstream (`tests/wire-contract-fakes.ts`) — INSIDE THE FIXING PR. The ledger never shrinks without owner sign-off. Golden schema snapshots (`tests/golden/wire-contract/*.json`) change only via explicit regeneration (`node --import tsx scripts/update-wire-contract-goldens.ts`) with the justification stated in the PR. A pin bump or tool-surface change that trips a gate is a stop-the-line signal, not something to loosen.
- **Honest output.** Never emit misleading messages for degenerate states (#155: export claimed "original conversation" for a 0-block session).
- **Logs.** Mask secret values in all logs; separate trace/debug/info; keep debug-on by default during bug-convergence phases (#247).
- **Docs.** Keep zh/en in sync; place content where the actual reader will see it; mirror env-var references into CONFIGURATION.md, not just one README (#571).

### 7.4 Auto-Merge Gate (this repo only)

A bugfix may **auto-merge** only if ALL hold:

1. Single-module scoped fix; no architectural change.
2. A regression test reproduces the original bug and now passes.
3. Green **on the rebased head** (typecheck + full test suite + build).
4. No change to: config schema, persistence format/version, wire protocol / message shape, or any change under `kernel/`.
5. Pure `fix:` — no new capability surface (not feat/refactor).
6. Clean diff: no unrelated changes, no mass whitespace/reformat, no generated or lock-file churn.
7. References its issue via `Fixes #N`.
8. Does NOT touch load-bearing infra: `src/update.ts`, release workflow, CI publish, `kernel/` (any facet), message-ref/id logic, or security (MITM/CA/credentials).

**Must stay human** (any hit): wire/message-shape changes (both modes affected), config schema or persistence version, any `kernel/` change, `src/update.ts` (needs a no-op release first), identity/session-binding logic, feat/refactor/architecture, security-related, or any fallback/default-value change (a product decision).

> **Scope note:** auto-merge applies to THIS repo only. Kernel changes (anything under `kernel/`, including its version bumps and releases) remain manual/human.

### 7.5 Reviewer Focus — the "重灾区" (second-round zones)

Of 326 analyzed merged PRs, 26 (~7%) needed a second+ human review round. Two drivers dominate, and they are exactly where auto-merge is unsafe:

1. **Stale-base / concurrent-file churn** — long-lived branches drift from fast-moving master and collide with other PRs on hot files. Gate signals: branch freshness, and whether a touched file is being rewritten by another open PR.
2. **Incomplete first pass** — the initial fix addresses the reported symptom but misses an adjacent path/edge case, leaves promised work unfinished, or needs its approach reconsidered. Gate signal: does the fix cover ALL paths of the bug, not just the repro?

These map directly onto §7.2–7.3; a reviewer walks those bullets in order.
