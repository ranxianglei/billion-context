# billion-context-release-notes (companion payload, #1870)

Tiered, model-written release notes consumed by the proxy's visibility
watcher (`src/update-notes.ts`): acp_status and the `/acp` panel use them to
tell users and agents "a critical update is ready — restart to finish" or
"a critical fix is available" — ONLY for `critical`-tier entries (#1977:
silent by default) — with a per-release summary and the user-side span
(everything between the running version and the newest release).

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
| tier     | yes      | `routine` (default) / `recommended` (restart soon, record-only) / `critical` (see below) |
| summary  | yes      | One user-meaningful line, ≤400 chars, model-written|
| summaryZh | no      | Chinese one-liner (≤400 chars) — zh-locale web surfaces pick it; `/acp` text stays English. Unset = every locale uses `summary` |
| minVersion | no      | Targeting: only RUNNING versions ≥ this (inclusive) see the entry. Unset = no floor |
| maxVersion | no      | Targeting: only RUNNING versions ≤ this (inclusive) see the entry. Unset = no ceiling |

Rules: newest-first, ≤20 entries, no duplicates. **Entries are opt-in since
2026-10-04**: only severe releases get one; ordinary releases ship with NO
entry (the workflow gates pass with a notice when the entry is absent and
validate it when present). Tier discipline (#1977):

- `routine` — default. The overwhelming majority of releases.
- `recommended` — "worth restarting soon" (correctness/cache fixes,
  self-heal fixes); RECORD-ONLY since #1977: it feeds the release log but
  never surfaces to users. NOT for marketing.
- `critical` — the release fixes a serious defect users must act on
  (correctness / data / billing class) that sits BELOW the advisory bar.
  The only tier that surfaces (`CRITICAL UPDATE READY/AVAILABLE` on
  acp_status + the `/acp` panel). Use sparingly and deliberately — a
  nag-per-release here is exactly what #1977 fixed.

Force-upgradeable critical defects stay in `advisories/` (#1481) — entries
here never trigger the safety chain, they only make an update visible.

## Release process (enforced by gates)

1. **Prep:** as part of the release prep, add the new version's entry to
   `release-notes/package.json` (tier + summary). The summary is
   model-written: describe what changes FOR THE USER, cite issue/PR numbers.
   Pick the tier per the discipline above — `critical` only for serious
   defect fixes users must act on; when in doubt, `routine`.
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
