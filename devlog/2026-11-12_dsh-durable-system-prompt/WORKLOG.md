# WORKLOG - dsh lane: the in-history system prompt is a durable carrier

- Task ID: `2026-11-12_dsh-durable-system-prompt`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-11-12

## 1. Summary

- **What was done**: added a fifth durable identity to the dsh lane classifier, `durable/system-prompt` (`dshSystemPromptPath`), governed by the existing `durable/*` latest-per-identity default.
- **Why**: dsh appends a changed system prompt in history on in-history routes; the newest copy is the prompt in force and was foldable.
- **Behavior / compatibility changes**: Yes, dsh lane only — see section 3.
- **Risk level**: Low (one classifier, existing policy machinery, no kernel/config/wire change).

## 2. Change Log

### Key Files

- `src/durable-message-guards.ts` — `dshSystemPromptPath`; consulted first in `dshDurableToolPath`; `oneShotCarrierPaths` deliberately unchanged.
- `src/config.ts` — comment only (the durable identity list).
- `tests/dsh-system-prompt-durable.test.ts` — classifier rows, fold geometry through the wire codecs, real folds on the Messages and chat-completions wires.

## 3. Design & Implementation Notes

- **Criterion**: `role === "system"`, text content, non-empty, not bili's own summary carrier, and not a structured system (`hasUnrecoverableMediaPayload`, reused from the kernel so the two rules cannot overlap). No text marker exists for a system prompt; the role is the evidence — it is stamped by the host serializer, and neither human input (user channel) nor model output (assistant channel) can produce it.
- **Order**: checked before the twelve marker classifiers. Their role gate is `!== "assistant"`, so on master a system prompt that quotes a marker (for example one that documents the skill-catalog tag) projects to that marker's identity and, being newer, takes the latest slot from the real user-channel carrier. With the role-decided identity first this no longer happens.
- **Behavior change (old → new), dsh lane only**:
  - newest plain-text in-history system: foldable → pinned (one live copy);
  - plain-text system-role text that contains a carrier marker: projected to that carrier's identity → `durable/system-prompt`;
  - a user who has taken over the durable policy with their own `durable/...` pattern gets no default, as before; `durable/system-prompt` is addressable like the other four.
- **Not changed**: drift accounting (`oneShotCarrierPaths`, `dshCarrierRawMarkers`), the kernel, any other lane.

## 4. Testing & Verification

- New file: 14 tests. On master c26c31ac (same assertions, classifier import shimmed): 10 fail, 4 pass — the 4 are the "unchanged" pins (unregistered lane ×3, Rule-3 anchor).
- Targeted suites (every test file that references the dsh lane or the durable guards, plus the in-history system suites): 85 files, all green except `tests/dsh-native.test.ts`, which is timing-flaky on unmodified master as well (2 of 5 baseline runs cancel 4 subtests; the file does not import the changed module).
- `npm run typecheck`, `npm run build`, `check-unused-exports`, `check-test-import-graph`, `config-surface-guard`, `check-architecture-docs`, `gen-config-docs generate` (no drift): clean.

## 5. Risk Assessment & Rollback

- **Risk points**: a third-party dsh plugin that emits a text-only developer message would serialize as a plain-text system and take the prompt identity (dsh core's only developer-role emitter carries tool blocks exclusively).
- **Rollback method**: revert the commit; no data format or config schema is involved.

## 7. Follow-ups

- [ ] Messages wire: once its neighbours are folded, the surviving prompt can sit in a position Anthropic-style APIs reject for `system`, and the kernel's position heal re-voices it as `user` (text intact). Keeping the system role there needs a kernel change (relocation, as PR #5800 does for tool-delta systems).
- [ ] Expected-rebase accounting for prompt copies the host retires when it re-baselines a request series.
