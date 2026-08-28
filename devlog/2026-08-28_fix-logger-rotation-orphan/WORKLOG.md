# WORKLOG

- Commit 380e323 on branch `2026-08-28_fix-logger-rotation-orphan` (PR #307,
  fixes #210): `src/logger.ts` rewritten around inode-based orphan detection;
  `tests/logger-rotation.test.ts` (+3); CHANGELOG entry under Unreleased →
  Fixes.

## Implementation (src/logger.ts)

- `streamFd` captured in the stream's `open` event (guarded by
  `stream === s`) — the `WriteStream` type exposes no `fd` property.
- `isOrphaned(s)`: `fstatSync(streamFd)` vs `statSync(logPath)`, comparing
  `ino` AND `dev`. Open still in flight (`streamFd === undefined`) → not
  orphaned; stat/fstat throws (path gone ENOENT/ENOTDIR, fd invalid EBADF) →
  orphaned.
- `getStream()`: reuse only when `stream && stream.writable &&
  !isOrphaned(stream)`; otherwise `closeQuietly()` (`end()` first so buffered
  lines drain into the rotated file — the fd follows the renamed inode, so the
  flush lands in `.old` whether it completes before or after the rename), then
  reopen. Success resets `reopenWarned`; failure → `warnReopenFailed(err)` and
  return undefined (stderr-only).
- `warnReopenFailed`: exactly one `[warn]` per degradation episode (flag
  `reopenWarned`), written to stderr with its own timestamp — deliberately
  bypasses `log()` to avoid recursion — and mirrored through `setLogCapture`.
- `configureLogger` now opens via `getStream()`, so a failed startup open
  degrades instead of crashing (previously an unguarded `openStream`).
- Runtime 10MB rotation branch in `log()` now `closeQuietly(s); stream =
  undefined; s = getStream()`. `closeLogger` resets `streamFd`.

## Tests (tests/logger-rotation.test.ts, +3)

1. External rename: write → settle → `renameSync` → write more → new file
   gets post-rename lines, pre-rename lines absent, `.old` size frozen.
2. Reopen failure: clobber the log dir with a regular file so
   `mkdirSync(dirname)` throws ENOTDIR on every reopen → no crash, exactly
   one `[warn]` (via `setLogCapture`), subsequent `log()` calls keep working
   stderr-only, file not resurrected.
3. Internal 10MB rotation regression: single 11MB line + post-rotation line →
   post-rotation line in the fresh file, `.old` >= 11MB. (stderr redirected
   to a temp file so the 11MB line doesn't flood the test runner.)

## Verification

- `npm run typecheck` clean; `npm test` 701/701 (698 + 3 new); `npm run build`
  tsup success, dist/index.js 2.51MB.
- Bug-repro check: ran the 3 new tests against the OLD logger
  (`git checkout origin/master -- src/logger.ts`): tests 1 and 2 FAIL, test 3
  passes — i.e. the new tests genuinely catch the orphan-inode bug (test 3 is
  the regression guard for the pre-existing internal rotation).

## Lessons

- A renamed fd never errors: error/writable-based recovery is blind to
  rename-based rotation. Inode compare (fstat vs stat, ino + dev) on every
  write is the only reliable detection for "file moved out from under us".
- The bug report's minimal fix (drop `stream` in the rotation branch) only
  covers our own 10MB rotation; external renames (logrotate, manual) need the
  per-write check.
- `end()` before reopen is what makes rotation lossless — `destroy()` would
  drop the buffer.
