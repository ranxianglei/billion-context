# billion-context Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**billion-context** is an npm package (`bili` CLI) — a context-compression proxy for AI agents. It sits between an agent client and an upstream LLM provider, injecting acp-kernel's compression pipeline to manage context growth.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling, inlines acp-kernel) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Dep | `acp-kernel` (bundled at build time, zero runtime deps in dist) |

### Repository Info

| Field | Value |
|-------|-------|
| npm package | `billion-context` |
| CLI | `bili` / `bili-proxy` |
| GitHub | https://github.com/ranxianglei/billion-context |
| License | MIT |

## 2. Architecture

### Module Map

```
billion-context/
├── src/
│   ├── index.ts                  # Entry: runs cli.ts main()
│   ├── cli.ts                    # CLI dispatcher: start/update/version/help
│   ├── server.ts                 # HTTP proxy server, request pipeline
│   ├── config.ts                 # Config loading (file + env + CLI flags)
│   ├── logger.ts                 # Tee logger: file (~/.local/state/) + stderr
│   ├── paths.ts                  # XDG paths (config/cache/state dirs)
│   ├── session.ts                # Session model + in-memory store
│   ├── session-id.ts             # Session ID generation
│   ├── message-id.ts             # Message ref ID generation
│   ├── persist.ts                # On-disk session persistence
│   ├── update.ts                 # Auto-update: checks npm, auto-installs latest
│   ├── stream.ts                 # SSE stream utilities + tag patching
│   ├── stream-openai.ts          # OpenAI-format stream processing
│   ├── stream-responses.ts       # Responses-API stream processing
│   ├── stream-error.ts           # Stream error handling
│   ├── sse-util.ts               # SSE parsing helpers
│   ├── compress-loop.ts          # Compress loop (OpenAI chat format)
│   ├── compress-loop-responses.ts # Compress loop (Responses API format)
│   ├── compress-tool.ts          # compress tool parsing
│   ├── decompress-shared.ts      # Shared decompress logic
│   ├── orphan-gc.ts              # Orphaned block cleanup
│   ├── anthropic.ts              # Anthropic adapter helpers
│   ├── openai.ts                 # OpenAI adapter helpers
│   ├── responses.ts              # Responses API helpers
│   ├── fetch-util.ts             # HTTP fetch with timeout
│   └── util.ts                   # Misc utilities
├── tests/                        # 16 test files, 141 tests
├── tsup.config.ts
└── package.json
```

### Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained (zero runtime deps)
2. **Tags use XML format** `<acp tokens="2" type="text">m00001</acp>` — written with hex escapes (`\x3c`, `\x3e`) to avoid Write/Edit tool stripping
3. **Auto-update**: checks npm registry every 3 min (`CHECK_INTERVAL_MS = 3*60*1000`), first check per process ignores throttle
4. **Tee logger**: all proxy logs go through `src/logger.ts` (file + stderr). Do NOT use `console.error` in server-side modules — use `loggerLog()`.
5. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.17"`, NEVER `"^0.0.17"`). Because acp-kernel is a build-time dependency that tsup bundles inline into `dist`, a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds. When bumping acp-kernel: set the exact version in `package.json`, run `npm install` to refresh the lockfile, then rebuild. The `package-lock.json` is committed and kept in sync.

## 3. Development Standards

### Build Commands

```bash
npm run build          # tsup bundle (inlines acp-kernel)
npm run typecheck      # tsc --noEmit --project tsconfig.build.json
npm test               # node --import tsx --test tests/*.test.ts
```

### Local Testing

```bash
npm run build
npm install -g billion-context@latest   # install from registry
bili start --port 8787
```

`npm install -g .` also works (installs from the local directory) and does NOT
create a symlink here — npm copies the package into the global `node_modules`
because `package.json` has proper `bin` + `files` fields. Either approach is
fine; the registry install is preferred for testing the real published
artifact.

### Code Quality

- **No `as any`**, **No `@ts-ignore`**
- **No comments unless absolutely necessary**
- Hex escapes required for any `<acp>` XML in source files
- **No `console.error` in server-side modules** — use `loggerLog(level, msg)` from `src/logger.ts`. The only exceptions are `src/cli.ts` (user-facing CLI errors) and `src/index.ts` (pre-logger startup crash).

## 4. Git Safety Rules (MANDATORY)

| Rule | Enforcement |
|------|-------------|
| **NEVER force-push to `master`** | Under no circumstances. (GitHub branch protection also blocks this.) |
| **NEVER merge PRs** | PR merges are human-only. The Agent MUST NEVER merge. |
| **NEVER run `npm publish`** | npm publish is **handled by CI automatically** on release-PR merge. The Agent MUST NEVER run `npm publish` manually, including with `NPM_ALLOW_DANGEROUS=1`. (See §5.) |
| **Branch naming** | `YYYY-MM-DD_short-title` |
| **NEVER modify `version` on non-release branches** | The `"version"` field in `package.json` is touched ONLY on `*_release-v*` branches. Content commits must NEVER bump it. (See §4 Version Bumps below.) |

### PR Merge — Absolute Prohibition

PR merges are a **human-only operation**. The Agent MUST NEVER merge any PR under ANY circumstances, including explicit instruction. If a human instructs merge, reply:

> I can't merge PRs — AGENTS.md forbids Agents from merging. Please merge yourself: [PR URL].

### npm Publish — Absolute Prohibition

`npm publish` is **handled by CI automatically** (see §5). The Agent MUST
NEVER run `npm publish` manually under ANY circumstances. This includes:

- **NEVER** use `NPM_ALLOW_DANGEROUS=1 npm publish` to bypass the guard
- **NEVER** use `npm pack` + manual install as a workaround
- **NEVER** bypass or attempt to bypass any npm guard or safety mechanism

If a human instructs manual publish, reply:

> I can't publish to npm — AGENTS.md forbids manual publishing. Releases are
> published automatically by CI when a release PR is merged. See §5. If you
> need a manual fallback, please run `npm publish` yourself.

### Version Bumps — One Version, One Commit, One Branch

The `"version"` field in `package.json` is the **single source of truth** for
what gets published. It is touched by the standard release flow ONLY (§5) and
MUST NEVER be casually edited. Two hard rules:

1. **`version` changes ONLY on release branches** (named `*_release-v*`).
   Feature/fix/refactor/docs commits leave `version` untouched. If you find
   yourself editing `version` on a content branch, **stop** — you are on the
   wrong branch.

2. **A release commit changes ONLY `version`** (+ `package-lock.json` if it
   drifts). Never bundle a version bump into a content commit, and never
   bundle content changes into a release commit. One version bump = one
   isolated commit with message `release v{VERSION}`.

**Why this is load-bearing:** CI (`release.yml`) detects a release by matching
the branch name (`*_release-v*`) AND the commit message (`release v{VERSION}`).
Bundling version into a content commit breaks the trigger and causes
three-way merge conflicts on `package.json` when the release branch lands.

If a human asks to "just bump the version" inside a feature/fix change,
reply:

> Version bumps go through the standard release flow (§5): a dedicated
> `*_release-v*` branch with an isolated `release v{VERSION}` commit. I can't
> bundle it into this change.

### Local Install

When testing locally, install from the **registry** to test the real
published artifact:

```bash
npm install -g billion-context@latest
```

`npm install -g .` is also acceptable (it copies the local package into the
global `node_modules` — it does NOT create a symlink here, because
`package.json` has proper `bin` + `files` fields). Just be aware the
installed version reflects whatever is in the project directory at install
time, not the registry.

## 5. Release Workflow

Releases are **fully automated via CI** (`.github/workflows/release.yml`).
The Agent prepares a release PR; merging it triggers CI which builds, tests,
publishes to npm, creates a git tag, and creates a GitHub Release.

### Branch Naming

Release branches: `YYYY-MM-DD_release-v{VERSION}` (e.g., `2026-08-08_release-v0.1.17`)

### Process (exact steps)

The Agent does steps 1–5, the human does step 6 (merge).

1. **Sync master**:
   ```bash
   git checkout master && git pull --ff-only origin master
   ```
2. **Create the release branch** from master:
   ```bash
   git checkout -b $(date +%Y-%m-%d)_release-v{VERSION}
   ```
3. **Bump version** — edit ONLY the `"version"` field in `package.json`:
   ```diff
   -    "version": "0.1.16",
   +    "version": "0.1.17",
   ```
4. **Local pre-flight** — run the same checks CI runs:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
5. **Commit, push, open PR** — release-commit convention:
   - Message: `release v{VERSION}`
   - The commit changes ONLY `package.json` (+ `package-lock.json` if it
     drifts). Never bundle other changes into a release commit.
   - PR title: `release v{VERSION}`; body lists changes since last tag.
6. **Human merges the PR** (Agent MUST NOT merge).
7. **CI publishes automatically** — no manual `npm publish`:
   - On merge, `release.yml` detects the `*_release-v*` branch name +
     `release v{VERSION}` commit message.
   - It runs `npm ci` + `typecheck` + `test` + `build`, then
     `npm publish --tag latest` (using the `NPM_TOKEN` repo secret),
     creates git tag `v{VERSION}`, and creates a GitHub Release.
8. **Verify** the published version is live:
   ```bash
   npm view billion-context version
   ```

### CI publish mechanism (what release.yml does)

- **Trigger**: push to `master` where the merge commit or branch name matches
  `*_release-v*`.
- **Prerelease handling**: if the version contains `-` (e.g. `0.1.17-beta.1`),
  publishes with `--tag dev` instead of `--tag latest`.
- **No publish step for the Agent**: the Agent never runs `npm publish`. The
  only manual fallback (if CI is down) is a human running `npm publish`.

### Cross-repo dependency: acp-kernel MUST ship first

`acp-kernel` is pinned in **devDependencies** (exact version, no `^`) and
**bundled inline** at build time, so `dist/index.js` is self-contained.

⚠️ **When bumping the acp-kernel dependency version:**
1. Release `acp-kernel` first (merge its release PR, wait for CI publish).
2. **Verify it is live on npm:** `npm view acp-kernel version` returns the new version.
3. THEN bump `acp-kernel` in this repo's `package.json` and release billion-context.

Rationale: billion-context CI runs `npm ci`, which installs the exact
`acp-kernel` version pinned in `package.json`. A release branch that bumps
`acp-kernel` to a not-yet-published version fails CI at install time.

### Auto-update testing

To test that a running older version auto-updates to a newer registry version:

```bash
# 1. Install older version from registry
npm install -g billion-context@0.1.16

# 2. Merge the newer release PR (HUMAN merges) — CI publishes 0.1.17 to npm.

# 3. Start the older version
bili start --port 19195
# Within ~10s (startup check) it detects 0.1.17 and installs it, logging:
#   ✔ billion-context auto-updated 0.1.16 → 0.1.17. Restart bili to finish.
```

## 6. Contributing

### Before Making Changes

1. `npm run typecheck` — no type errors
2. `npm test` — all tests pass
3. Understand the module dependency graph

### Commit Convention

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code restructuring
- `test:` test changes
- `docs:` documentation
- `release:` version bump