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
│   ├── cli.ts                    # CLI dispatcher: start/update/export/test/plugin + client launchers
│   ├── server.ts                 # HTTP proxy server, request pipeline
│   ├── config.ts                 # Config loading (file + env + CLI flags)
│   ├── logger.ts                 # Tee logger: file (~/.local/state/) + stderr
│   ├── paths.ts                  # XDG paths (config/cache/state dirs)
│   ├── session.ts                # Session model + in-memory store
│   ├── session-id.ts             # Session ID generation
│   ├── persist.ts                # On-disk session persistence (kernel StateStore)
│   ├── update.ts                 # Auto-update: checks npm, auto-installs latest
│   ├── launcher.ts               # `bili <client>` launchers (pi/codex/claude/omp/opencode/hermes)
│   ├── client-config.ts          # READ-only discovery of each client's upstream config
│   ├── mitm.ts / ca.ts           # Cert-MITM proxying + lazily generated root CA
│   ├── mcp.ts                    # Plugin-in-launcher MCP shell (spawn-time injection)
│   ├── plugin.ts / plugin-install.ts # Cooperative plugin protocol + `bili plugin install`
│   ├── registry.ts               # models.dev context-window registry (snapshot-first)
│   ├── registry-snapshot.json    # Bundled full models.dev snapshot (offline floor)
│   ├── upstream-proxy.ts         # undici ProxyAgent routing (https_proxy for registry fetch)
│   ├── stream.ts                 # SSE stream utilities + tag patching
│   ├── stream-openai.ts          # OpenAI-format stream processing
│   ├── stream-responses.ts       # Responses-API stream processing
│   ├── stream-error.ts           # Stream error handling
│   ├── sse-util.ts               # SSE parsing helpers
│   ├── loop/                     # Unified compress loop (wire-agnostic core)
│   │   ├── core.ts               #   protocol-neutral event model + tool adjudication
│   │   ├── adapter-anthropic.ts  #   Anthropic wire adapter (buffer-to-finish tool calls)
│   │   ├── adapter-openai.ts     #   OpenAI chat adapter (buffer-to-finish, raw passthrough)
│   │   └── adapter-responses.ts  #   Responses API adapter
│   ├── compress-loop.ts          # Compress loop (OpenAI chat format)
│   ├── compress-loop-responses.ts # Compress loop (Responses API format)
│   ├── compress-settings.ts      # Three-level compress config merge
│   ├── compress-tool.ts          # compress tool parsing (kernel parseCompressArgs)
│   ├── decompress-shared.ts      # Shared decompress logic
│   ├── orphan-gc.ts              # Orphaned block cleanup
│   ├── agent/                    # Thin agent-side plugins (pi/omp/opencode)
│   ├── web/                      # Web UI (config + context windows)
│   ├── fetch-util.ts             # HTTP fetch with timeout
│   └── util.ts                   # Misc utilities
├── tests/                        # 66 test files
├── tsup.config.ts
└── package.json
```

### Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained (zero runtime deps)
2. **Tags use XML format** `<acp tokens="2" type="text">m00001</acp>` — written with hex escapes (`\x3c`, `\x3e`) to avoid Write/Edit tool stripping
3. **Auto-update**: checks npm registry every 3 min (`CHECK_INTERVAL_MS = 3*60*1000`), first check per process ignores throttle
4. **Tee logger**: all proxy logs go through `src/logger.ts` (file + stderr). Do NOT use `console.error` in server-side modules — use `loggerLog()`.
5. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.17"`, NEVER `"^0.0.17"`). Because acp-kernel is a build-time dependency that tsup bundles inline into `dist`, a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds. When bumping acp-kernel: set the exact version in `package.json`, run `npm install` to refresh the lockfile, then rebuild. The `package-lock.json` is committed and kept in sync.
6. **Two compression modes with different summary carriers** — `pluginMode` (the `x-bili-plugin` header / registered agent, e.g. `bili pi`) means the ACP-native agent OWNS compression: it executes `compress` locally, the call+result live in its own re-sent history, and the summary carrier on the wire is the **tool call** (the proxy suppresses tool + nudge injection; the agent's view never renders the kernel's `acp_summary`). Proxy mode (plain client, no header) means the proxy executes `compress` server-side: the tool call is ephemeral (never enters the client's history) and preflight blocks have none, so the summary carrier is the **`acp_summary` message**, which the kernel renders as role `system` but `systemToUser` (`src/util.ts`) re-voices as a **`user` message** (leaving it at its anchor) so strict backends (SGLang: exactly one system at index 0, #377) accept it and the head system message stays byte-stable for the prefix cache. The mode is decided per request and bound per session (`session.metadata.pluginAgent`, sticky, upgrade-only). See README "Two compression modes".

### Kernel Contract: Message Ids Are Never Reused

The kernel (`acp-kernel`) guarantees, and billion-context RELIES on: within a
session, a raw content-hash id and a ref number (`mNNNNN`) denote exactly one
message forever — **never reused, never duplicated**, even after the message
dies (edited/truncated/folded). The model can cite any number it has ever
seen (summaries cite tags across turns), so a re-issued number silently
misattributes on decompress. Consequences for this repo:

- Host code must NOT prune/repack `session.state.messageRefs` in ways that
  let a freed number be re-issued (kernel `assignRefsNode` computes its
  cursor as `highestUsedIndex(map)+1`, so shrinking the map can drop the
  cursor and re-issue numbers).
- Known residual: `applyCompactionArchive` (#421, `src/session.ts`) prunes
  `byRaw/byRef` to live raw ids on native-compaction boundaries. In practice
  the highest-numbered (newest) messages stay resident so the cursor does not
  drop, but this is a theoretical re-issue window — drop the map-prune once
  the kernel's ref-space widening (post-#191 direction) makes it unnecessary.
- Do not bump `acp-kernel` to ≥0.0.48/0.0.49 (contain ref-slot reclamation,
  reverted in kernel #191); resume bumping at the release that lands the
  revert.

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

### E2E Regression (real client through bili)

`tests/e2e/e2e-codex.test.ts` drives the **real `codex` CLI** through a built
proxy against a real Responses-compatible upstream and asserts the full
context lifecycle end-to-end: warmup → load growth → ACP compress → purity →
native-compact interception (last phase gated by `E2E_FORGE=1`). Full phase
details, env vars, and mechanics: `tests/e2e/README.md`.

```bash
# zero-token preflight (codex binary + dist + upstream reachable)
E2E_CHECK=1 node --import tsx --test tests/e2e/e2e-codex.test.ts

# full run (defaults to local sglang at http://127.0.0.1:8199/v1, zero cost)
npm run build
ACP_TEST_E2E=1 node --import tsx --test tests/e2e/e2e-codex.test.ts

# + native-compact interception phase
ACP_TEST_E2E=1 E2E_FORGE=1 node --import tsx --test tests/e2e/e2e-codex.test.ts
```

Rules:

- The suite **skips by default** so `npm test` stays free; never remove the
  `ACP_TEST_E2E` gate.
- Run it (at least the 4-phase core) before merging changes to the request
  pipeline — `server.ts`, `src/loop/`, adapters, preflight/compact paths.
  It is the only coverage that exercises real client behavior (codex UA,
  wire quirks, retry loops).
- Any Responses-compatible upstream works via `E2E_UPSTREAM_URL` /
  `E2E_UPSTREAM_KEY`; the provider is configured as `name = "OpenAI"` so codex
  stays on the remote compaction (V2) path — do not "fix" this.
- CI (`.github/workflows/ci-e2e.yml`) is manual-dispatch only and needs repo
  secrets `E2E_UPSTREAM_URL` / `E2E_UPSTREAM_KEY`; a hosted runner cannot
  reach `127.0.0.1` upstreams.

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
| **NEVER print the GitHub PAT** | The token stays in a shell variable only. See "Opening PRs without the `gh` CLI" below. |
| **Branch naming** | `YYYY-MM-DD_short-title` |
| **NEVER modify `version` on non-release branches** | The `"version"` field in `package.json` is touched ONLY on `*_release-v*` branches. Content commits must NEVER bump it. (See §4 Version Bumps below.) |

### PR Merge — Absolute Prohibition

PR merges are a **human-only operation**. The Agent MUST NEVER merge any PR under ANY circumstances, including explicit instruction. If a human instructs merge, reply:

> I can't merge PRs — AGENTS.md forbids Agents from merging. Please merge yourself: [PR URL].

### Opening PRs without the `gh` CLI

This environment has **no `gh` CLI** — but `git push` works (credential
helper) and the same credential can open PRs through the GitHub REST API:

```bash
# 1. push the branch (auth is automatic via the git credential helper)
git push origin HEAD

# 2. get a token from the credential helper (shell variable only — never print it)
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' \
  | git credential fill | sed -n 's/^password=//p')

# 3. write the PR payload to a file (safe for multi-line markdown bodies)
cat > /tmp/pr.json <<'EOF'
{
  "title": "fix: short summary",
  "head": "YYYY-MM-DD_short-title",
  "base": "master",
  "body": "what changed, why, and pre-flight results (typecheck / test / build)"
}
EOF

# 4. open the PR (base is master)
curl -sS -f -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/ranxianglei/billion-context/pulls \
  -d @/tmp/pr.json
```

A successful response contains `"state": "open"` and the `html_url` to post
back to the issue; `-f` makes API errors (401/422) fail loudly instead of
exiting 0 with an error JSON body. The credential helper is
non-interactive — it either serves the token or fails, so if `git push`
worked, the token extraction works. Never print the token; keep it in the
variable only. Merging the PR stays human-only (see above).

### Issue Work — Required Deliverables

When an Agent picks up an issue, these deliverables are MANDATORY:

1. **Finished development → PR.** When the development for an issue is
   complete, open a PR (recipe above). An issue is NEVER "done" without a PR —
   always reply in the issue thread with the PR link.
2. **Major problems / big bugs found while working → report + open an issue.**
   Significant defects (broken functionality, data-loss risk, security issues,
   architectural problems) must be (a) reported in the current issue thread AND
   (b) filed as a separate new issue with repro, impact, and a suggested fix.
3. **Minor problems → report only.** Small issues (typos, cosmetic defects,
   minor UX quirks) are reported in the current issue thread only — do NOT
   open separate issues for them.

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

### ⚠ Releasing changes to the auto-update mechanism itself

**The auto-update code (`src/update.ts`) is load-bearing for every future
upgrade.** If a release ships a broken auto-update, users who install it become
**permanently stuck** — they can never auto-update again (the broken thing is
the updater itself), and many will never notice to manually reinstall. This is
strictly worse than a normal bug: a normal bug affects one feature; a broken
updater silently bricks the upgrade path for everyone who hits it.

**Therefore: any change to `src/update.ts` (the download / extract / install /
version-check logic) MUST be validated with a no-op release BEFORE shipping the
change.** The sequence is:

1. **Ship a no-op release first** (pure version bump, zero code changes) — this
   proves the *existing* upgrade path is healthy end-to-end: the currently-
   installed version auto-updates to the no-op release using the *old* code.
   - Branch: `YYYY-MM-DD_release-v{VERSION}` (same naming convention).
   - Commit: `release v{VERSION}` (version bump only).
   - PR body MUST state it is a no-op and why (validation release).
2. **Only after the no-op release is confirmed on npm** (`npm view
   billion-context version` returns it) AND a real upgrade has been observed
   succeeding (the log shows `auto-updated OLD → NEW`), ship the actual change
   as a separate subsequent release.
3. If the no-op release's upgrade **fails**, STOP. Do not ship the updater
   change. Investigate the existing-path failure first — the existing code is
   the only known-good upgrade path, and shipping a change on top of an
   already-broken path compounds the problem.

**Why the indirection?** Because if the change-to-the-updater is itself buggy,
   anyone who upgrades to it is bricked. The no-op release isolates the test:
   it exercises the upgrade path using code we already trust, so a success
   confirms the *plumbing* (registry, tarball, file copy, restart) works,
   independent of the new code. Only then do we trust the new code to run on
   the next hop.

**Concrete example (v0.1.22):** the Windows auto-update fix (replacing
`execFile("tar"/"cp")` with the `tar` npm package + `fs.cp`) was staged in
PR#44 but NOT shipped directly. A no-op v0.1.22 (PR#46, version bump only)
was released first to confirm the running v0.1.21 could self-upgrade. Only
after that succeeded was the Windows fix shipped in a follow-up release.

## 6. Contributing

### Before Making Changes

1. `npm run typecheck` — no type errors
2. `npm test` — all tests pass
3. Understand the module dependency graph
4. **Consider BOTH compression modes** — any change touching the wire (message rebuild, system/developer handling, tool injection, `acp_summary` stripping, preflight, nudge) must be reasoned about in BOTH plugin mode (carrier = the agent's `compress` tool call; proxy suppresses injection) and proxy mode (carrier = the `acp_summary` message re-voiced as `user` by `systemToUser`; proxy executes `compress` server-side). A change correct in one mode can break the other (#377 only manifested in proxy mode). See README "Two compression modes" and the `pluginMode` comment in `src/server.ts`.

### Commit Convention

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code restructuring
- `test:` test changes
- `docs:` documentation
- `release:` version bump