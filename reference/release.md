# Release Workflow Reference

> **Not auto-loaded.** On-demand mechanics pulled out of `AGENTS.md` §5 to keep the
> auto-loaded spec lean. The hard rules (never manual publish, version-only-on-release-branch,
> kernel changes are human-gated, updater changes need a no-op release first) stay in
> [`AGENTS.md` §5](../AGENTS.md#5-release-workflow); this file holds the exact steps,
> the one-click workflow internals, and the no-op validation protocol.

Releases are **fully automated via CI** (`.github/workflows/release.yml`; kernel
releases use `.github/workflows/release-kernel.yml`). The Agent prepares a release PR;
merging it triggers CI which builds, tests, publishes to npm, creates a git tag, and
creates a GitHub Release. For routine patch releases there is also a one-click fast
path below.

## Branch Naming

Release branches: `YYYY-MM-DD_release-v{VERSION}` (e.g., `2026-08-08_release-v0.1.17`)

Kernel release branches: `YYYY-MM-DD_release-kernel-v{VERSION}` (e.g. `2026-11-01_release-kernel-v0.0.102`) — see "Kernel releases" below.

## Process (exact steps)

The Agent does steps 1–6, the human does step 7 (merge).

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
   Then regenerate the lock so its root + `file:`-link version fields track the
   bump — editing `package.json` alone does NOT touch `package-lock.json` (#2704):
   ```bash
   npm install --package-lock-only --ignore-scripts --no-fund --no-audit
   git diff --exit-code -- package-lock.json   # must be clean before you commit
   ```
    CI enforces this with the `lock-sync` guard (`ci.yml`).
 3.5. **Sync plugin manifest versions (#4449)** — run on the release branch,
    AFTER the bump commit, and commit the result as its own commit:
    ```bash
    node scripts/sync-codex-plugin-version.mjs
    git add .agents .claude-plugin plugins/codex
    git commit -m "chore: sync plugin manifests to v{VERSION}"
    ```
    Why: the four plugin manifests (`.agents/plugins/marketplace.json`,
    `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`,
    `plugins/codex/.codex-plugin/plugin.json`) carry their own `version` fields —
    Codex/Claude marketplaces detect updates by comparing that declared version
    against the installed cache, so a stale manifest means "no update available"
    forever for that lane. `package.json` is the single source of truth; the
    script copies it into all four (idempotent — if nothing drifted the commit is
    empty and you skip it). All three publish workflows run `--check` BEFORE
    tag/publish (`release.yml` fails fast before any CI dispatch; `release-manual.yml`
    syncs inside CI as part of its own release commit; `release-bugfix.yml` checks
    the frozen carve-out head) — drift = red release, nothing shipped. A bugfix
    carve-out PR head MUST therefore already carry the synced manifests (see the
    carve-out process below).
 4. **Add the release-notes entry — ONLY for severe releases (#1870, opt-in
   since 2026-10-04)** — ordinary releases skip this step entirely and ship
   with NO entry. When a release IS severe, add the entry in the SAME release
   PR, as its own commit (never bundled into the release commit): prepend an
   entry to the `releases` array in `release-notes/package.json`:
   ```json
   {
     "version": "0.1.17",
     "date": "2026-08-08",
     "tier": "recommended",
     "summary": "what changes FOR THE USER, one line, issue/PR refs"
   }
   ```
   - `tier`: `routine` (default) | `recommended` (restart-soon record —
     correctness/cache/self-heal fixes; NOT user-visible, marketing is NEVER
     recommended) | `critical` (a serious defect users must act on — the only
     tier that ever surfaces to users, #1977; use sparingly, when the fix
     matters more than the silence). Force-upgradeable defects go to
     `advisories/`, never here.
   - The summary is model-written, ≤400 chars, newest-first order, cap 20
     entries. NEVER hand-edit the companion package's own `"version"` field —
     CI bumps it on publish.
   - Full rules: `release-notes/README.md`. Enforcement: the gates in
     `release.yml` / `release-manual.yml` / `release-bugfix.yml` pass with a
     notice when the entry is absent (silent release, the default) and
     validate it when present.
5. **Local pre-flight** — run the same checks CI runs:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
5.5. **Local real-model release gate** (operator machines with live models —
    the regression lane GitHub CI can never run). After `npm run build`:
   ```bash
   npm run gate:local
   # or against an already-built tarball:
   node scripts/release-gate-local.mjs --tarball /path/to/billion-context-X.Y.Z.tgz
   ```
   This freezes the manual v0.1.196 review pass (PR #2962) into one command.
   Lanes: **A** compression — real dsh session at a small-window route forces
   a mid-turn fold (`nudge INJECT` → preflight → `acp-compress-obs`), then the
   SAME session keeps answering from folded context with cache recovered
   (≥50% on a stable-prefix follow-up); **B** model switch — same session
   resumed on a DIFFERENT model / upstream (same lineage — a dsh
   resume-replay fork that ADOPTS the parent's folded blocks counts as pass,
   an orphaned pfa does not —, folded state survives a proxy restart,
   cross-upstream baseline demoted to untrusted, cache cold→hot); **U**
   (`--with-update`, needs verdaccio + `GATE_VERDACCIO_NPMRC`) — the profile
   proxy recognizes its dsh-managed install and reads `latest` from the
   configured update registry. Everything is hermetic (own `DSH_HOME`,
   `BILI_CONFIG_FILE`, sessions/XDG dirs, ports); it never touches `~/.dsh` or
   running proxies. Prerequisites are probed and missing lanes are skipped
   with a warning — see the header of `scripts/release-gate-local.mjs` for all
   `GATE_*` knobs. Windows-specific update lanes (global installer,
   desktop-profile in-place swap, doctor) stay on the Win10 VM checklist below.
6. **Commit, push, open PR** — release-commit convention:
   - Message: `release v{VERSION}`
   - The commit changes ONLY `package.json` (+ `package-lock.json` if it drifts).
     Never bundle other changes into a release commit.
   - PR title: `release v{VERSION}`; body lists changes since last tag.
7. **Human merges the PR** (Agent MUST NOT merge).
8. **CI publishes automatically** — no manual `npm publish`:
    - On merge, `release.yml` detects the `*_release-v*` branch name +
      `release v{VERSION}` commit message.
    - It runs `npm ci` + `typecheck` + `build`, plus the full test suite UNLESS a
      reuse probe proves it redundant: every required CI lane already green at the
      PR head AND master did not move since the PR head (#3539 — the full suite is
      then paid for exactly once per chain; human-cut PRs with core lanes only never
      skip). The full-CI gate still blocks publish until every lane is green at the
      publish sha (fresh or reused). Then `npm publish --tag latest` (using the
      `NPM_TOKEN` repo secret), git tag `v{VERSION}`, GitHub Release.
9. **Verify** the published version is live:
   ```bash
   npm view billion-context version
   ```

## One-click manual release (fast path)

For routine patch releases, skip the branch/PR dance: **Actions → "Release
(one-click)" → Run workflow** (`.github/workflows/release-manual.yml`). The `version`
input is optional — blank means auto next-patch over the npm latest; type a full
semver for minor/major/prerelease bumps.

**Severe-release prerequisite (#1870):** if the version being released is
severe, its release-notes entry must ALREADY be merged to master
(`release-notes/package.json`, same shape as step 4 above) — the workflow
checks at dispatch time and logs the entry when found. Ordinary releases
need NO entry: a missing entry is a notice, not an abort. Prereleases (dev
channel) are exempt.
The workflow then:

1. **Drift guard**: master's `package.json` version must equal the npm latest, else it
   aborts (never release off a drifted tree). It also rejects a target version that is
   already published. A separate dispatch-time step then logs the
   release-notes entry for the target version when present (#1870) — see the
   prerequisite above.
2. Bumps ONLY `package.json` + `package-lock.json` and commits `release v{VERSION}` —
   the same one-version-one-commit discipline as `AGENTS.md` Version Bumps.
3. Runs the fast pre-flight gate (`npm ci` + typecheck + build). The FULL test suite
   deliberately does NOT run here anymore (#3539): it runs exactly once, as the sharded
   CI lanes dispatched at the exact publish sha in the next steps, and the full-CI gate
   blocks publish until they are all green — same coverage, parallel shards instead of
   ~30-40 min serial on one shared runner.
4. Pushes the release commit directly to `master` (GITHUB_TOKEN, fast-forward only).
   On success the run dispatches every missing CI lane at the release commit — refusing
   first if master's head has moved past it — and blocks until all lanes are green
   before publishing.
   If branch protection blocks direct pushes, the release lands on a release branch
   instead and the run tries to open the release PR itself (best-effort — if the account
   forbids Actions-created PRs the run still finishes green with a one-click "open the
   release PR" link in the job summary). The fallback PR body carries a generated
   changelog (`git log` since the last release tag); the same notes appear in the job
   summary as a paste-ready block for opening the PR manually. Merging that PR
   publishes via the standard flow; red is reserved for real failures (guard trips,
   gate failures, or a failed branch push). GitHub suppresses push-event delivery for
   ref updates made with GITHUB_TOKEN, so the push trigger never fires on the fallback
    branch; instead the run invokes `scripts/release-ci-gate.mjs --dispatch` with
    `CI_FULL_DISPATCH=1`, which fires the COMPLETE lane set at the branch head in one
    pass — `ci.yml` in FULL matrix scope plus every e2e lane (each requires the
    `workflow_dispatch` trigger the workflows declare for exactly this purpose). Those
    check runs land on the same head sha — once green, required checks pass and the
    auto-PR is mergeable without approving its `action_required` pull_request runs
    (bot-authored PRs are gated there) (#772, #1744). Because the full set goes green
    at the PR head, `release.yml` reuses every run at merge time instead of re-running
    the suites (#3539: one full pass per chain). The dispatch refuses to fire if the
    branch head no longer matches the release commit, cancels stale in-flight runs from
    the attempt, and a follow-up track-head wait step certifies "PR ready": if master
    gets merged into the release branch mid-wait, stale runs at the old head are
    cancelled and missing lanes re-dispatched at the new head instead of burning
    runners on a superseded sha (the v0.1.198 queue stomp, #3539/#3534). If the dispatch
    fails (transient API error), the fallback PR stays gated until someone approves
    those runs manually. (Push-triggered CI on release branches still works for branches
    pushed with a real account token — e.g. agent-driven standard-flow release branches.)
5. Publishes to npm (`latest`, or `dev` for prerelease), tags `v{VERSION}`, and creates
   the GitHub Release with notes generated from `git log` since the last tag.

A successful one-click run does NOT double-trigger `release.yml`: its check only
matches release-branch merges / date-prefixed commits, never a plain `release v{VERSION}`
commit. The standard branch/PR flow above remains the canonical path for anything
non-trivial (updater changes, cross-repo bumps, or whenever a human wants the review
gate).

## Bugfix carve-out channel (release-bugfix.yml)

Emergency hotfix path (#2011, first used for v0.1.182), **PR-gated since #2851**:
publish a version cut from a **non-master ref** — typically a released tag plus a
single fix commit — STRICTLY excluding the unreleased work that has since
accumulated on master. It goes through a PR exactly like a normal release (human
reviews and merges; CI publishes); the ONLY difference is the published tree: the
PRE-MERGE PR-head tree (last tag + the fix + the version bump), never the
post-merge master.

`release.yml` cannot do this: it builds the post-merge MASTER tree on push-to-master,
so it can never exclude commits already on master. This channel checks out and
publishes the carve-out PR's head tree instead — the artifact is exactly that tree,
nothing else.

**Process:**

1. Cut the hotfix branch from the last released TAG (not master), apply ONLY the fix
   plus the version bump (regenerate `package-lock.json` as in step 3 above; sync the
   plugin manifests as in step 3.5 above — the publish gate's `--check` runs against
   this frozen head, so drift fails the whole lane; plus the release-notes entry ONLY
   if the hotfix is severe — step 4 above), then push and open a PR against master:
   ```bash
   git checkout -b bugfix-release/v{VERSION}-{slug} v{LAST-RELEASED-TAG}
   ```
   The `bugfix-release/` name prefix is the carve-out MARKER, not a trigger: pushing
   such a branch no longer auto-publishes (#2851 removed the silent-push path). It is
   what `release.yml`'s detection deliberately does NOT match, so merging the PR
   cannot double-publish the post-merge master through the normal channel.
   Guard-compatibility requirement: the ci.yml `version-guard` MUST whitelist this
   prefix in parallel with `*_release-v*` — a carve-out PR legally carries exactly
   one isolated release-bump commit. #2858 was exactly this divergence: #2853
   updated release-bugfix.yml / AGENTS.md / this doc but not ci.yml, so every
   carve-out PR went red on version-guard and the fail-closed full-CI gate blocked
   every merge-time publish until the guard was fixed on master.
2. **Human reviews and merges the PR** — the same review gate as a normal release
   PR. While it is open, the standard lane set already runs on the head sha
   (path-filtered `pull_request` triggers), which the publish gate reuses.
3. On merge, `release-bugfix.yml` (`pull_request` closed trigger) validates
   (merged, same-repo head, `bugfix-release/*` branch), checks out the PRE-MERGE PR
   head tree, reads the target version from its `package.json` (before any gate) and
   enforces fail-closed guards:
   - strictly newer than npm latest (base-semver compare — never holds or downgrades
     `latest`; conservative edge: a stable `X` is refused while npm latest is `X-dev`);
   - not already published (`npm view billion-context@$VER`);
   - no sub-0.1.0 lines (#1385);
   - severe stable versions need a release-notes entry ON THE REF (#1870;
     ordinary releases ship with none; prereleases exempt).
4. Full pre-flight gate before publish: `npm ci` + typecheck + test + build
   (`ACP_TEST_CLAUDE_NATIVE=1`, #1248), plus the full-CI gate at the publish sha
   (reusing the PR's own green lane runs where they exist).
5. Publishes `--tag latest` (`dev` for prereleases), pushes tag `v{VERSION}`, creates
   the GitHub Release with notes generated from `git log` between the nearest ancestor
   tag other than the one just made and HEAD — for a tag+one-fix carve-out that list
   is exactly the fix (deliberately NOT `generate_release_notes:true`, which would span
   into unreleased master work).

**Emergency fallback:** a manual `workflow_dispatch` run against an explicitly chosen
ref (picked in the Actions UI) still works and runs every guard above — for when the
PR dance is slower than the fire.

**Conflicted ship PRs (label publish):** a lane/carve cut from an OLD tag can
conflict with master at ship time — the fixes already landed there and master
moved on, so GitHub's merge button refuses. Resolving on the lane is FORBIDDEN
(`Never merge master into a lane` below — the publish tree must stay leak-free)
and resolving on master needs a direct master push. For that case: add the
`backport-ship` label to the OPEN ship PR (head branch must match `bugfix-v*` /
`bugfix-release/*`, same-repo, not a fork). `release-bugfix.yml`'s
`pull_request_target` trigger then publishes the PR's HEAD tree with every guard
above — no merge required; the PR stays open as the publish record (the workflow
leaves the audit comment on it). `pull_request_target` runs the master copy of the
workflow, so lanes cut from old tags — whose own `release-bugfix.yml` predates the
`bugfix-v*` marker and would silently skip the closed-PR path — publish correctly
too. Master syncs later via a normal metadata-only PR, or simply advances on its
next regular release (which must be higher anyway).

**Master interaction:** merging the carve-out PR brings the version bump INTO master
(master then equals npm latest, so the one-click fast path's drift guard sees a clean
tree again). Master advances independently on its next normal release, which MUST be
higher than the carve-out version (after v0.1.182 was cut off v0.1.181, the next
normal release must be ≥ 0.1.183).

## Dual-lane releases: label → carry PR → ship

Operationalizes the carve-out channel into a **standing patch lane**, so small
fixes ship fast WITHOUT blocking (or being blocked by) master's feature stream.
Approved by the owner 2026-10-24 (supersedes the earlier patch-train form).

**The model:** master stays the single source of truth (features + big fixes
merge there as always). In parallel, a **patch lane** — the branch
`bugfix-v<latest-tag>` (e.g. `bugfix-v0.1.206`) cut from the last released TAG —
accumulates small fixes as cherry-picks. A patch release ships the lane (tag +
that batch of fixes, strictly no unreleased features) via the carve-out
channel; merging the lane's ship PR brings the fixes and the version bump back
into master. Version numbers stay one strictly-increasing stream (0.1.206
patch, 0.1.207 feature, 0.1.208 patch … all legal). The lane name IS its base
tag — no stored pointer anywhere: GITHUB_TOKEN cannot touch the actions-
variables API (the earlier variable-based bot 403'd on its maiden run), so the
current lane is always DERIVED as `bugfix-v$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)`.

**Routing a fix (label BEFORE merge):** apply the `backport` label to the
fix's OPEN PR — any base, any state. `backport.yml` reacts at once:

1. Resolves the current lane; cuts it from the latest tag if nobody has yet.
2. Cherry-picks the PR's OWN commits (`merge-base(origin/master, head)..head`,
   `--no-merges`, in order) onto a fresh `backport/carry-N` branch off the lane.
3. Opens/refreshes the **carry PR** (base = lane, labeled `backport-carry`).
   **Conflicts are material, not comments:** conflicting picks are skipped,
   listed INSIDE the carry PR body with per-commit replay commands, and stay
   visible until a human resolves them there. (The pre-lane era lost conflicted
   backports as PR comments — #4474.) Zero clean picks → no carry PR, receipt
   comment with manual commands instead.
4. Posts a **receipt comment** on the source PR (marker `pin:<sha>
   carry:<n>`): where the copy lives, pinned head, conflict status. Relabeling
   after further edits rebuilds the existing carry from the new head;
   re-labeling without changes no-ops (idempotent).
5. Dispatches the CORE CI matrix on the carry ref (#772: token pushes carry no
   push events).

Because the trigger is the LABEL, not the merge: **a fix may land on the lane
WITHOUT ever reaching master** (temporary hotfix), or reach both — the source
PR closes independently either way. Which lane a fix actually belongs to is
decided by the cherry-pick itself: clean pick = fast lane; conflicts = resolve
in the carry PR or let it ride the next regular release. New features never
take the lane. Labeling an ALREADY-merged PR also works (`workflow_dispatch`
repair path included).

**Why label-before-merge instead of merge-range:** merge-based picking depends
on `merge^1..merge^2` semantics and must refuse squash/rebase merges outright
(rewritten SHAs would ship a PARTIAL fix silently). Pick-from-head works for
every merge shape, every time, and lets temporary fixes stay lane-only.

**Ship the lane** (owner-gated, #2910): **Actions → "Release (one-click)" →
tick `train`**. That resolves `bugfix-v<latest-tag>` (cutting it if missing —
an EMPTY lane refuses to ship with a clear error), drift-guards (lane version
== npm latest), adds the isolated `release v{NEXT}` commit, pushes it to the
lane, dispatches the FULL CI set, and opens the ship PR against master with a
changelog. You merge it; `release-bugfix.yml` publishes the PRE-MERGE head tree
(tag + carried fixes) and creates the fresh tag — which by derivation CLOSES
this cycle: the next `backport` label automatically cuts `bugfix-v{NEXT}` from
the fresh tag. No closeout step exists because nothing is stored. If the ship
PR CONFLICTS with master (fixes already landed there, master moved on): do not
resolve on the lane, do not touch master — apply the `backport-ship` label to
publish the head tree without merging (see the carve-out channel section).

⚠ Severe fixes riding the lane: include the release-notes entry (#1870) in the
source fix PR so the carry picks transport it — the publish gate checks the
entry ON THE REF.

**Cutting / abandoning a lane** (rarely needed — derived + auto-cut):
```bash
git checkout -b bugfix-v{LATEST} v{LATEST} && git push -u origin bugfix-v{LATEST}   # cut now
git push origin --delete bugfix-v{LATEST}                                           # abandon (only if empty)
```

**A feature release overtakes an open lane:** if a normal release ships a new
tag while the lane is open, derivation moves forward by ITSELF — the next
label targets the fresh lane cut from the new tag, and shipping the stale lane
fails release-bugfix's strictly-newer-than-npm guard. Fixes are never lost
(their carries exist and can be re-labeled against the new cycle).

**Never merge master into a lane** — a git merge drags every unshipped master
commit over the merge-base, the exact leak this model exists to prevent. The
SHA-differing cherry-pick is the price of leak safety, and
`lane-leak-guard.yml` fails any lane push whose history contains a merge whose
second parent is a master ancestor.

**CI wiring:** pushes to `bugfix-v*` / PRs INTO a lane / carry branches run the
CORE matrix (ci.yml trigger filters); the FULL matrix at ship time comes from
`release-bugfix.yml`'s dispatch. The `ci.yml` version-guard allowlists
`bugfix-v*` heads (their ship PR carries the one legal bump commit).

## CI publish mechanism (what release.yml does)

- **Trigger**: push to `master` where the merge commit or branch name matches
  `*_release-v*`.
- **Prerelease handling**: if the version contains `-` (e.g. `0.1.17-beta.1`), publishes
  with `--tag dev` instead of `--tag latest`.
- **No publish step for the Agent**: the Agent never runs `npm publish`. The only manual
  fallback (if CI is down) is a human running `npm publish`.

## Kernel releases (standalone `acp-kernel` artifact, #2092)

The kernel source lives in-repo under `kernel/` and is consumed via
`"acp-kernel": "file:./kernel"`, so every billion-context release bundles the in-tree
kernel — there is NO registry ordering to manage anymore (the old "acp-kernel MUST
ship first" rule is obsolete).

When accumulated kernel changes warrant a standalone npm release of `acp-kernel`
(downstream consumers such as the legacy billion-context-pi pick it up as usual):

1. Branch `YYYY-MM-DD_release-kernel-v{VERSION}` off master.
2. ONE commit `release kernel v{VERSION}` changing ONLY the version in
   `kernel/package.json` (then regenerate the root `package-lock.json` so
   `packages.kernel.version` tracks it — same command as step 3 above; enforced by
   the `lock-sync` guard, #2704).
3. Open a PR (its body serves as the release notes; no release-notes entry required).
   HUMAN merges.
4. `.github/workflows/release-kernel.yml` runs on the merge: full bili gate
   (typecheck + test + build) plus the kernel suite against its TS source, then
   publishes `acp-kernel` from `kernel/`, tags `kernel-v{VERSION}`, creates a GitHub
   Release.

Cross-trigger safety: `*_release-kernel-v*` and `*_release-v*` are mutually exclusive
in every matching direction (release.yml's merge-branch regex, direct commit messages
`release v*` vs `release kernel v*`, the version-guard job, the kernel-guard job), and
the tag namespaces never collide (`v*` vs `kernel-v*`).

## Auto-update testing

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

## ⚠ Releasing changes to the auto-update mechanism itself

**The auto-update code (`src/update.ts`) is load-bearing for every future upgrade.** If
a release ships a broken auto-update, users who install it become **permanently stuck**
— they can never auto-update again (the broken thing is the updater itself), and many
will never notice to manually reinstall. This is strictly worse than a normal bug: a
normal bug affects one feature; a broken updater silently bricks the upgrade path for
everyone who hits it.

**Therefore: any change to `src/update.ts` (the download / extract / install /
version-check logic) MUST be validated with a no-op release BEFORE shipping the change.**
The sequence is:

1. **Ship a no-op release first** (pure version bump, zero code changes) — this proves
   the *existing* upgrade path is healthy end-to-end: the currently-installed version
   auto-updates to the no-op release using the *old* code.
   - Branch: `YYYY-MM-DD_release-v{VERSION}` (same naming convention).
   - Commit: `release v{VERSION}` (version bump only).
   - PR body MUST state it is a no-op and why (validation release).
2. **Only after the no-op release is confirmed on npm** (`npm view billion-context
   version` returns it) AND a real upgrade has been observed succeeding (the log shows
   `auto-updated OLD → NEW`), ship the actual change as a separate subsequent release.
3. If the no-op release's upgrade **fails**, STOP. Do not ship the updater change.
   Investigate the existing-path failure first — the existing code is the only known-good
   upgrade path, and shipping a change on top of an already-broken path compounds the
   problem.

**Why the indirection?** Because if the change-to-the-updater is itself buggy, anyone who
upgrades to it is bricked. The no-op release isolates the test: it exercises the upgrade
path using code we already trust, so a success confirms the *plumbing* (registry,
tarball, file copy, restart) works, independent of the new code. Only then do we trust
the new code to run on the next hop.

**Concrete example (v0.1.22):** the Windows auto-update fix (replacing
`execFile("tar"/"cp")` with the `tar` npm package + `fs.cp`) was staged in PR#44 but NOT
shipped directly. A no-op v0.1.22 (PR#46, version bump only) was released first to
confirm the running v0.1.21 could self-upgrade. Only after that succeeded was the
Windows fix shipped in a follow-up release.

## Local real-model gate on the Win10 VM (manual checklist)

`npm run gate:local` covers the Linux lanes. The Windows-only update lanes are
NOT automatable from the host yet; before a release that touched
`src/update.ts`, `src/dsh-channel.ts` or the installer, run this checklist on
the Win10 VM (per the operator's VM runbook; all commands in cmd.exe):

1. Baseline: pin global + the 4 dsh profiles (acp/headless/desktop/web) to the
   PREVIOUS release from the local verdaccio registry; `bili --version` must
   report it.
2. Set `"update": {"registry": "http://<verdaccio-LAN-IP>:4873"}` in the VM's
   billion-context.json; publish the candidate tarball to verdaccio first.
3. `bili update` → expect: global bump, `refreshed … dsh profile bundle(s)`,
   desktop in-place swap, and (when upgrading FROM a version that already has
   #2894) `[update] dsh desktop profile manifest spec now declares vX.Y.Z`
   with the profile package.json spec converged (`^old` → `^new`).
4. `bili doctor` → 0 stale / 0 frozen lanes.
5. Restart the fixed 8787 instance (run-bili3.bat) and re-run the dsh
   compression / model-switch / cache checks (Lane A/B equivalents).
