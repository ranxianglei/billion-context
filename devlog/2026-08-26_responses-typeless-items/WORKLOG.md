# WORKLOG

- A/B reproduction: mock upstream enforcing per-model windows (mock.js),
  omp via isolated PI_CODING_AGENT_DIR, control = global bili 0.1.56
  (switch → upstream 400 "maximum context length" reproduced), fixed =
  master + #254 (a0b80c7) built in /tmp/bc-pr254-local.
- First fixed run failed to trigger preflight: kernel saw 13 of 29 items —
  all 15 type-less user items dropped by the projection (dump analysis,
  `input items:` counter). Offline probes (probe3/4) confirmed kernel is
  fine with typed ids.
- Fix: `normalizeResponsesMessageItems()` in src/loop/adapter-responses.ts,
  wired in prepareResponses BEFORE sanitizeResponsesInputIds /
  dropWhitespaceResponsesMessages (canonical form for both).
- Adversarial small-window scenarios (3 giant turns / 8 notes vs 8744
  window) still 400: kernel protection (preserveRecentMessages 5 +
  preserveRecentTokens 5000) dominates tiny windows; preflight compresses
  one batch then T1 pending hits 0. Accepted as non-representative — real
  switches target >=262k windows where protection is ~2%.
- Realistic-ratio e2e PASSED (12×12KB, 100k→24k): see REQ.md.
- Note: repo-local node_modules carried acp-kernel 0.0.43 vs lockfile 0.0.46
  (stale); worktree corrected with `npm install --no-save acp-kernel@0.0.46`
  before building. Local builds from a stale checkout bundle the old kernel.
- tests/responses-empty-messages.test.ts +1 (normalize matrix). 647/647,
  typecheck, build green.
