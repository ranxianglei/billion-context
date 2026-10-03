# billion-context-release-notes (companion payload, #1870)

Tiered, model-written release notes. Since #1977 the proxy-side visibility
watcher is gone — updates are silent by default and only critical
advisories (`advisories/`, #1481) auto-surface — so this doc is now a
release-process artifact: the dispatch-time release gate (release-manual.yml /
release.yml, #1870) requires an entry for every stable release, and the tier +
summary record what each release changed for the user. The companion package
publish stays as the machine-readable carrier for any future consumer.

Companion package mechanics mirror `advisories/` (#1481):

- The payload lives in the custom field `billionContextReleaseNotes` of this
  package's packument; `latest` on npm is the live doc.
- CI (`.github/workflows/release-notes.yml`) validates and publishes a new
  patch version of this package on every push to `master` touching
  `release-notes/**`. The `version` field here is a placeholder — never bump
  it by hand.

## Entry shape (schema 1)

| Field    | Required | Notes                                              |
|----------|----------|----------------------------------------------------|
| version  | yes      | Exact released version (semver)                    |
| date     | no       | `YYYY-MM-DD` release date                          |
| tier     | yes      | `routine` (default) or `recommended` (restart soon)|
| summary  | yes      | One user-meaningful line, ≤400 chars, model-written|

Rules: newest-first, ≤20 entries, no duplicates. `recommended` is for
"worth restarting soon" (correctness/cache fixes, self-heal fixes) — NOT for
marketing. Critical defects stay in `advisories/` — this doc never claims
critical.

## Release process (enforced by gates)

1. **Prep:** as part of the release prep, add the new version's entry to
   `release-notes/package.json` (tier + summary). The summary is
   model-written: describe what changes FOR THE USER, cite issue/PR numbers.
2. Merge to master. The publish workflow ships the updated doc.
3. Dispatch the one-click release (or merge the release PR).
   `release-manual.yml` checks the entry at dispatch time; `release.yml`
   re-checks before tagging/publishing. A stable release without an entry
   fails the run. Prereleases (dev channel) are exempt.

Example entry:

```json
{
  "version": "0.1.180",
  "date": "2026-10-02",
  "tier": "recommended",
  "summary": "OpenCode WebSocket traffic is intercepted again — compression and usage stats no longer silently no-op on OpenCode ≥ 2.0.20 (#1844)."
}
```
