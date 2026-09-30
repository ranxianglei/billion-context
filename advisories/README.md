# billion-context-advisories

Machine-readable critical-defect advisories for [billion-context](https://github.com/ranxianglei/billion-context) (bili). bili's advisory watcher polls this package's registry document on the same cadence as the self-updater and, when the local version falls inside an entry's `affected` range, force-installs the entry's `target` version — even for installs with auto-update turned off.

## How to publish an advisory

1. Edit `package.json` in this directory: append an entry to `billionContextAdvisories.advisories` and bump `updated`:

   ```json
   {
       "id": "bc-2026-001",
       "affected": ">=0.1.155 <0.1.158",
       "target": "0.1.157",
       "reason": "0.1.155–0.1.156 corrupts tool-call arguments on retry; upgrade to 0.1.157 or later.",
       "publishedAt": "2026-09-27T12:00:00Z"
   }
   ```

2. Commit and push to `master`. CI (`.github/workflows/advisories.yml`) validates the payload (schema, required fields, semver syntax of `affected`/`target`) and, when valid, publishes a new patch version of this package to npm automatically. An invalid document fails the build and is NOT published.

## Entry fields

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Stable identifier, e.g. `bc-2026-001`. Used to dedupe warnings per process; never reuse an id. |
| `affected` | yes | Semver range of broken versions, e.g. `>=0.1.155 <0.1.158`. |
| `target` | yes | Exact version to force-install. May be OLDER than the user's current version (rollback semantics) when a newer release is also affected. Must be a published version of `billion-context`. |
| `reason` | yes | User-facing explanation, shown verbatim in the log warning and the web UI banner. Write it for end users, not developers. |
| `publishedAt` | no | ISO timestamp. |

## Retiring an advisory

Remove the entry (keep its id permanently retired) and publish again. Clients stop matching on the next check cycle (~3 min + restart).

## Notes

- The document lives in the packument under the custom field `billionContextAdvisories`; clients validate `schema: 1` and fail open on anything they do not understand.
- Trust domain: same npm registry as the tarballs bili already auto-installs. Publishing requires repo secret access (`NPM_TOKEN`) — only CI and maintainers can ship advisories.
- This package must never contain code; it is data only.
- When several entries match the local version, the FIRST listed entry applies (document order) — publish disjoint ranges or order entries by priority.
