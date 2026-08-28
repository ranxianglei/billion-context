# REQ: Logger survives log-file rotation (orphan inode)

Issue #210: after `bili.log` is renamed to `bili.log.old` (internal 10MB
rotation, logrotate, or a manual rename), the logger's held `WriteStream`
(`flags: "a"`) fd points at the renamed inode and every subsequent line
silently lands in `.old` while the fresh `bili.log` sits at 0 bytes — until a
restart. No `error` event ever fires because the orphaned fd is still valid,
so the old error/writable-based recovery never triggered.

The bug report's suggested fix (set `stream = undefined` in the rotation
branch) only covers our own 10MB rotation, not external renames. Triage on
#210 chose the general detection: inode compare on every write.

## Acceptance criteria

- After an external rename of the log path, the next log line lands in the
  fresh file; the renamed file's size is frozen.
- If a (re)open fails (disk full, perms, path clobbered), logging degrades to
  stderr-only with a single `[warn]` (one per degradation episode, reset on
  successful reopen) — no crash, proxy keeps serving. Covers both runtime
  reopens and the startup `configureLogger` open (previously an unguarded
  `openStream` that could crash startup).
- Internal 10MB rotation keeps working (regression guard).
- No lost lines on rotation: the old stream is closed with `end()` first so
  its buffer drains into the rotated file.

## Constraints

- Logging can never crash the server (existing invariant).
- No new dependencies; `fstatSync`/`statSync` per write is acceptable
  (two sync syscalls per log line).
