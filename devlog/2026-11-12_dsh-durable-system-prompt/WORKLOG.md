# WORKLOG - dsh lane: the in-history system prompt is a durable carrier

- Task ID: `2026-11-12_dsh-durable-system-prompt`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-11-15

## 1. Summary

- **What was done**: added a fifth durable identity to the dsh lane classifier, `durable/system-prompt` (`dshSystemPromptPath`), governed by the existing `durable/*` latest-per-identity default.
- **Why**: dsh appends a changed system prompt in history on in-history routes; the newest copy is the prompt in force and was foldable.
- **Behavior / compatibility changes**: Yes, dsh lane only — see section 3.
- **Risk level**: Low (one classifier, existing policy machinery, no kernel/config/wire change).

## 2. Change Log

### Key Files

- `src/durable-message-guards.ts` — `dshSystemPromptPath` (and its module-private `hostSentSystemText`); consulted first in `dshDurableToolPath`; `oneShotCarrierPaths` deliberately unchanged.
- `src/config.ts` — comment only (the durable identity list).
- `tests/dsh-system-prompt-durable.test.ts` — classifier rows, fold geometry through the wire codecs, real folds on the Messages and chat-completions wires.

## 3. Design & Implementation Notes

- **Criterion**: `role === "system"`, text content, non-empty, not bili's own summary carrier, and not a structured system (`hasUnrecoverableMediaPayload`, reused from the kernel so the two rules cannot overlap). No text marker exists for a system prompt; the role is the evidence — it is stamped by the host serializer, and neither human input (user channel) nor model output (assistant channel) can produce it.
- **Empty node, decided on the host's bytes** (added 2026-11-15, found by re-checking the "non-empty" criterion through the real codecs): `text` is not the host's bytes in two places, and in both an empty system node read as non-empty, resolved to `durable/system-prompt` and, when it came after the prompt in force, took its latest slot. In the first place that made the prompt foldable again; in the second it skewed the protection set of whatever classifies that view.
  - The Messages codec gives an empty system message the placeholder text `"[system]"` (`kernel/src/wire/anthropic.ts` `systemMessageText`; the same value seeds the id). Affected shapes: `content: ""` and a single text block whose text is empty or missing. Whitespace-only content and several blank blocks were already excluded (their `text` is whitespace), and `content: []` is not plain text, so the kernel's structured-system pin owns it.
  - A view rendered with ref tags (`processTurn` with `renderTags`) puts the tag in front of a numbered message's `text`, so there an empty node read as non-empty on all three wires. The plugin tool endpoint hands that view to its status and recommendation recompute; the fold itself reads the raw view where it has one. On the chat-completions and responses wires the raw view (which the tests at the previous head covered with a hand-built core) was right: those codecs keep an empty `text` empty.
  - `hostSentSystemText` asks the verbatim wire sidecar that the Messages, chat-completions and responses codecs attach to an in-history system (`rawAnthropicMessage`, `rawOpenaiMessage`, `rawResponsesItem`) whether the host sent any non-whitespace text; a core without a sidecar is judged on `text`, as before. It is not a comparison against the placeholder: a host that really sends those eight characters keeps the identity. It only narrows what the identity matches; nothing new is pinned. No kernel change.
  - The empty node itself is ordinary history again, as on master and on every lane without a classifier: numbered, tagged and foldable (on the Messages wire its rendered text is the tag followed by the placeholder; kernel behavior, not changed here).
  - Where empty in-history system nodes come from: `tests/issue4778-dsh-goal-subfork.test.ts` records DSH NEXT resending persisted EMPTY system entries on chat-completions (`{ role: "system", content: "" }`). The dsh 0.2.2-rc.2 package puts none on the Messages wire: a blanked prompt node has empty content and yields no wire message (`packages/core/session/src/surface.ts`), and the llm-deepseek serializer refuses an empty in-history system update (`packages/llm/llm-deepseek/src/serialize.ts`). So on the Messages wire this closes the documented exclusion rather than a reported failure.
- **Order**: checked before the twelve marker classifiers. Their role gate is `!== "assistant"`, so on master a system prompt that quotes a marker (for example one that documents the skill-catalog tag) projects to that marker's identity and, being newer, takes the latest slot from the real user-channel carrier. With the role-decided identity first this no longer happens.
- **Behavior change (old → new), dsh lane only**:
  - newest plain-text in-history system: foldable → pinned (one live copy);
  - plain-text system-role text that contains a carrier marker: projected to that carrier's identity → `durable/system-prompt`;
  - a user who has taken over the durable policy with their own `durable/...` pattern gets no default, as before; `durable/system-prompt` is addressable like the other four.
- **Not changed**: drift accounting (`oneShotCarrierPaths`, `dshCarrierRawMarkers`), the kernel, any other lane.

## 4. Testing & Verification

- New file: 14 tests with the first three commits. On master c26c31ac (that 14-test version of the file, the new export stubbed to return `undefined` so the file loads): 9 fail, 5 pass — the 5 are the classifier negatives and the "unchanged" pins (unregistered lane ×3, Rule-3 anchor).
- Targeted suites (every test file that references the dsh lane or the durable guards, plus the in-history system suites), run on the first commit: 85 files, all green except `tests/dsh-native.test.ts`, which is timing-flaky on unmodified master as well (2 of 5 baseline runs cancel 4 subtests; the file does not import the changed module).
- `npm run typecheck`, `npm run build`, `check-unused-exports`, `check-test-import-graph`, `config-surface-guard`, `check-architecture-docs`, `gen-config-docs generate` (no drift), run on the first commit: clean.
- Empty-node commit: the file has 16 tests (codec rows for the empty shapes in the classifier tests; an empty node after the prompt in a fold; the rendered view on each wire). With the source of the previous head 5a4423f0, 3 of the 16 fail (the Messages rows in the negatives, the empty node taking V3's latest slot, the rendered view). Three single-point mutations of `hostSentSystemText` (`some` → `every`; dropping the string check on a block's text; reading the Messages sidecar only) each fail one test. Re-run for this commit: `npm run typecheck`, `check-unused-exports`, `check-test-import-graph`, `config-surface-guard` clean; the 10 test files that import the changed module: 80 tests, all pass; `tests/verif-bug3805-durable-ref-migration.test.ts` (names the module in a comment only): 2 tests, both skipped (no solver available). `npm run build`, `check-architecture-docs`, `gen-config-docs` and the 85-file run were not repeated.

## 5. Risk Assessment & Rollback

- **Risk points**:
  - A dsh plugin that emits a developer message with text would take the prompt identity wherever the serializer ships that text as its own plain system/developer item: `llm-pi-ai` on chat-completions and responses does so even when the message also carries tool blocks; on the Messages wire only a text-only one does (text plus tool blocks stay one structured system). dsh core's only developer-role emitter (tool-registry) carries tool blocks exclusively.
  - `hostSentSystemText` trusts the wire sidecar to be the host's bytes. On chat-completions the sidecar is the same object the codec re-emits, and output steering (default off) rewrites the last system/developer message of a loop resend in place; an empty node in that position would read as non-empty afterwards. Read from the code, not exercised.
  - Token cost: the newest copy is never folded, so its size is permanently outside what compress or preflight can reclaim (#6193 reports a 45,463-character prompt).
- **Rollback method**: revert the commit; no data format or config schema is involved.

## 7. Follow-ups

- [ ] Messages wire: once its neighbours are folded, the surviving prompt can sit in a position Anthropic-style APIs reject for `system`, and the kernel's position heal re-voices it as `user` (text intact). The end-to-end test pins that role so a kernel change shows up. Keeping the system role there needs a kernel change (relocation, as PR #5800 does for tool-delta systems); #4172 is the same class.
- [ ] No retroactive unfold: `prune` drops covered ids without consulting protection, and a merge takes a consumed block's coverage whole, so a newest prompt covered by a block from an older build stays hidden until the next prompt update.
- [ ] `oneShotCarrierPaths` has no system-role step: system-role text containing a carrier marker is the prompt for the slot chain and that marker's carrier for drift accounting (unchanged from before; pinned in the test file).
- [ ] Expected-rebase accounting for prompt copies the host retires when it re-baselines a request series.
