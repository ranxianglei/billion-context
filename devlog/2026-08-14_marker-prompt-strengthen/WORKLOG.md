# WORKLOG - Harden compress prompts against exec-sandbox tool confusion + restart-pending nag

- Task ID: `2026-08-14_marker-prompt-strengthen`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-14 17:40

## 1. Summary

- **What was done**: Added an EXEC SANDBOX WARNING to all three compress system-prompt builders (function / text-marker / hybrid) forbidding `tools.acp_status()`-style calls inside the code-execution sandbox (quoting the exact `TypeError: tools.acp_status is not a function` from the incident) and pointing to the correct path; added a throttled (30 min) `restart pending` WARN in `checkForUpdate` when the on-disk version is newer than the running process.
- **Why**: Postmortem of the 5.57M-token Codex session showed the model compensating for invisible context state by calling ACP tools inside the exec sandbox (always TypeError) and re-reading files 247×; and the 0.1.40 fix being installed but never activated because restart was only hinted at by a single info line.
- **Behavior / compatibility changes**: Prompt text only (all protocols) + one new WARN log line. No API/protocol/config changes.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<see PR>` | fix(prompts): exec-sandbox warning in all compress prompts + update restart-pending nag |

### Key Files

- `src/compress-tool.ts` — `buildCompressSystemPrompt` (top-level function-call note), `buildCompressTextSystemPrompt` + `buildCompressHybridSystemPrompt` (EXEC SANDBOX WARNING after trigger rules)
- `src/update.ts` — `lastRestartNag` / `RESTART_NAG_MS` (30 min); WARN in `checkForUpdate` after disk-version read when `isNewer(disk, running)`
- `tests/fix-exec-sandbox-prompt.test.ts` — 4 new tests (prompt content ×3 modes, nag fires exactly once across two checks)

## 3. Verification

- `npm run typecheck` clean.
- `npm test`: 374/374 pass (370 prior + 4 new).
- Windows-relevant: no platform-specific code touched (pure string/log changes).

## 4. Lessons Learned

- A proxy-level tool that is invisible to the model's runtime (function call vs sandbox object) invites compensation loops; prompts must pre-empt the exact error string the model will see.
- Auto-update that swaps files under a running process creates a "phantom up-to-date" state: the disk version satisfies the registry check, so without comparing disk vs the running process constant, staleness is unobservable.
