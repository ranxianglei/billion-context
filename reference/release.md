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
   plus the version bump (regenerate `package-lock.json` as in step 3 above; plus the
   release-notes entry ONLY if the hotfix is severe — step 4 above), then push and
   open a PR against master:
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

**Master interaction:** merging the carve-out PR brings the version bump INTO master
(master then equals npm latest, so the one-click fast path's drift guard sees a clean
tree again). Master advances independently on its next normal release, which MUST be
higher than the carve-out version (after v0.1.182 was cut off v0.1.181, the next
normal release must be ≥ 0.1.183).

## Dual-lane releases: the patch train (backport label bot)

Operationalizes the carve-out channel from "one fix per branch" into a **standing
patch train**, so small fixes ship fast WITHOUT blocking (or being blocked by)
master's feature stream. Approved by the owner 2026-10-24.

**The model:** master stays the single source of truth (features + big fixes merge
there as always, nothing is frozen). In parallel, a `bugfix-release/**` train branch
— cut from the last released TAG — accumulates small fixes as cherry-picks. A patch
release ships the train (tag + that batch of fixes, strictly no unreleased features)
via the existing carve-out channel; merging the train's ship PR brings the fixes and
the version bump back into master. Version numbers stay one strictly-increasing
stream (0.1.206 train, 0.1.207 feature, 0.1.208 train … all legal).

**Which lane a fix takes** (the objective test is the cherry-pick, not an upfront
opinion): if the fix applies cleanly onto the tag-based train and stands alone there
→ small fix, fast lane. If it conflicts or depends on unreleased master work → slow
lane, rides the next regular release. New features never take the train.

**Mechanics:** the only manual steps are the label, the carry merge, and the ship
decision; cutting the train, carrying fixes, refreshing, and closing the cycle
after ship are all automatic. The bot never pushes the train directly — fixes
land on it through carry PRs the owner clicks (label-time creation, owner rule
2026-10-24 session #2: "打 backport 里面出一个一样的 pr，不是合并的时候才出").
The open train is **derived, never stored**: the newest
`bugfix-release/*` branch whose BASE version is strictly above the latest
`v*` tag (suffix stripped — `v0.1.206-train` counts as 0.1.206, so once the
tag catches up the train auto-derives as closed). Cutting one = pushing such
a branch; publishing one = the tag catching up. There is deliberately NO
Actions variable pointing at it — GITHUB_TOKEN cannot read/write the
actions-variables API (403 "Resource not accessible by integration"; no
`permissions:` category grants it), which is exactly how the first,
variable-based version of the bot failed on its maiden run.

1. **Route a fix onto the train**: add the `backport` label to its PR —
   the carry PR appears IMMEDIATELY (label time, not merge time).
   `backport.yml` then:
   - cuts a train automatically if none is open — `bugfix-release/v{NEXT}-train`
     from the latest released `v*` tag (NEXT = patch+1) — and says so on the PR;
   - cherry-picks the PR's own commits onto a carry branch `backport/<n>`
     (built from the CURRENT train tip; open-PR picks use the exact PR-branch
     range `base..head`, housekeeping merges excluded via `--no-merges`) and
     opens the carry PR — same content, same title, different base (the train);
   - dispatches the CORE CI matrix on the carry branch (#772: token pushes
     carry no push events) and leaves an audit comment with the carry link.
   New commits pushed to the labeled PR refresh the carry branch automatically
   (same carry PR). Merging the original PR does a final refresh; closing it
   unmerged closes the carry PR automatically. The owner merges the carry PR
   into the train whenever ready — that merge is the only way a fix reaches
   the train.
   For repairs on ALREADY-merged PRs (late label, or the manual dispatch
   `pr=<number>`) only MERGE-COMMIT merges are auto-carried (the repo
   convention): squash/rebase merges rewrite the commit SHAs, and for a
   multi-commit rebase picking just the final commit would silently ship a
   PARTIAL fix — the bot refuses to guess and comments the manual command
   instead. No label → master lane only, nothing lost (the bot says so on the
   PR). A cherry-pick conflict is the objective "not a small fix" signal —
   the fix stays on master and the bot comments the manual command (a
   previously created carry keeps its last good content).
2. **Ship the train** (the one owner decision — releases are owner-gated,
    #2910): **Actions → "Release (one-click)" → Run workflow → tick `train`**.
    That does the whole dance: derives the open train, checks it out,
    drift-guards (train version must equal npm latest), adds the isolated
    `release v{NEXT}` commit (package.json + lock only), pushes it to the train,
    dispatches the FULL CI set at the train head, and opens the ship PR against
    master with a generated changelog. You merge the PR; `release-bugfix.yml`
    then publishes the PRE-MERGE head tree (tag + fixes) — and the fresh tag
    closes the train cycle by derivation, so the next labeled merge cuts the
    next train from it automatically. (Manual equivalent: release commit on
    the train + push + ship PR against master, exactly like step 3 of the
    normal process.)
    ⚠ Severe fixes riding a train: include the release-notes entry (#1870) in
    the fix PR itself, so the backport cherry-pick carries it onto the train —
    the publish-time gate checks the entry ON THE REF, and the train's copy
    otherwise lags at the base tag's.

    **Ship-time audit (#4474)**: a conflicted backport leaves only a PR
    comment — easy to miss, and CI green on the train head says nothing
    about fixes that are ABSENT. Before opening the ship PR, the one-click
    train run reconciles every backport-labeled merge since the train's base
    tag against the cherry-pick `-x` trailers on the train. Any no-show is
    rendered as a prominent ⚠️ section at the top of the ship PR body (it
    never fails the run — you may legitimately ship without the straggler,
    but you will see it before you merge).

**Cutting / abandoning a train** (rarely needed — the bot cuts automatically):
```bash
# cut a train NOW (e.g. to stage it before the first labeled merge lands):
git checkout -b bugfix-release/v{NEXT}-train v{LAST-RELEASED-TAG} && git push -u origin bugfix-release/v{NEXT}-train
# abandon an open train (e.g. its fixes should ride the next regular release):
git push origin --delete bugfix-release/v{NEXT}-train
```

**Known edge — a feature release overtakes an open train**: if a regular
`*_release-v*` release ships a version ≥ the train's target while the train is
 open, the fresh tag catches up to the train's base version and the train
 AUTO-DERIVES AS CLOSED immediately (its ship PR would also fail release-bugfix's
 strictly-newer-than-npm guard, by design). Resolution: delete the overtaken
 branch (`git push origin --delete …`) and let the next labeled merge cut a fresh
 train from the new tag — the bot does that automatically. (Rebasing the old
 branch onto the new tag does NOT reopen it: derivation reads the base version
 out of the branch NAME, which rebasing cannot change.) The fixes are never
 lost — they are all on master too.

**Why cherry-pick instead of merging the fix branch into the train:** the fix branch
is based on master; a git merge into the tag-based train would carry every master
commit since the tag over the merge-base — the exact feature leak the train exists
to prevent. (This also means a "same commit SHA on both lines" dual-PR scheme is
NOT possible in this model — the SHA-differing cherry-pick is the price of leak
safety.)

**CI wiring**: pushes to `bugfix-release/**` and PRs into a train run the CORE
matrix (ci.yml trigger filters include the pattern); the FULL matrix at ship time
comes from `release-bugfix.yml`'s all-lanes dispatch, same as the single-fix
carve-out. Branch protection for `bugfix-release/**` (no force-push, no deletion)
keeps trains from being rewritten mid-cycle.

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
