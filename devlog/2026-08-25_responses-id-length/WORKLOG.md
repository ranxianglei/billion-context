# Worklog

## 2026-08-25

- Root cause (by #243 author): `src/loop/adapter-responses.ts` round-2 mapping
  embedded the full upstream message id → 66 chars > 64 cap. Fixed by hashing
  with the existing `hashId()` (sha256-16hex); lifecycle events share the mapped
  id via the `remapped` map, so references stay intact.
- Healing (added by maintainer, per PR review agreement): new
  `sanitizeResponsesInputIds()` export — `prepareResponses` rewrites any
  `input[].id` > 64 chars to `msg-fix-<hashId>` (deterministic, idempotent,
  in-place) before the projection reads the input. Poisoned rollouts recover on
  their next request. Uses the same `hashId()` for consistency.
- Tests: round-2 lifecycle regression with the real 54-char Codex id + ≤64
  assertion (from #243); sanitize unit test (short ids untouched, deterministic,
  call_id untouched, non-array tolerated).
- Verified: typecheck ✅, 594/594 ✅, build ✅ (2.46 MB).
- #244 (duplicate root-cause fix by maintainer) closed as superseded by #243.
