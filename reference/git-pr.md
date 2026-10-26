# Git / PR Reference

> **Not auto-loaded.** On-demand mechanics pulled out of `AGENTS.md` §4 to keep the
> auto-loaded spec lean. The prohibitions (never force-push/merge/publish/print-PAT,
> branch naming, version discipline) stay in [`AGENTS.md` §4](../AGENTS.md#4-git-safety-rules-mandatory);
> this file holds the exact "open a PR without `gh`" recipe and the external-contributor
> / post-merge-supplement mechanics.

## Opening PRs without the `gh` CLI

This environment has **no `gh` CLI** — but `git push` works (credential helper) and the
same credential can open PRs through the GitHub REST API:

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

A successful response contains `"state": "open"` and the `html_url` to post back to the
issue; `-f` makes API errors (401/422) fail loudly instead of exiting 0 with an error JSON
body. The credential helper is non-interactive — it either serves the token or fails, so if
`git push` worked, the token extraction works. Never print the token; keep it in the variable
only. Merging the PR stays human-only (`AGENTS.md` §4).

## External Contributors' PRs — Fix Directly, Don't Replace

The owner rule (小问题直接修, 2026-10-01) applies regardless of authorship: fixes are pushed as **additive commits to the contributor's PR branch**, whoever authored the PR — same as any other branch. What stays off-limits is REPLACING the contribution: no rebase-and-replace with an Agent-owned PR, no closing a still-mergeable contribution in favor of a new one (#1765) — the contributor's commits, diff and authorship stay in the merged history.

Two mechanics to check before assuming a contributor's PR is broken:

- **A deleted head branch does NOT kill an open PR.** GitHub freezes the PR head at
  `refs/pull/N/head`; recreating the branch does not re-attach it, but the frozen head can
  still be `MERGEABLE` with green checks. Check `mergeable`/`mergeStateStatus` first.
- **`BEHIND` is not a blocker.** The PR does not need to contain the latest master; the
  merge button (or an owner's merge commit) handles it.

## Supplements After a Merge — Follow-up PR, Never the Merged PR

When something is missing or wrong AFTER a PR was merged, the supplement goes into a
**small follow-up PR whose body references the original PR number** — never pushed into,
rebased onto, or appended to the merged PR. Keep the original contribution history intact
(its commits, its diff, its author). Verify first that a supplement is actually needed: a
review that replays the same commit on newer master is verification, not content.
