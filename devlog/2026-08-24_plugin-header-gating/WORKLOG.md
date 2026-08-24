# WORKLOG - Plugin header gating

- Task ID: `2026-08-24_plugin-header-gating`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-24 17:25

## 1. Summary

- **What was done**: `before_provider_headers` now stamps `x-bili-plugin*`
  only after `registerTools()` has completed (`toolsReady` on `RegisterState`).
- **Why**: the stamped header claims plugin ownership; stamping it before the
  tools exist sent round 1 out with no ACP tools (one-shot `-p` runs never
  recovered until round 2 in interactive sessions).
- **Behavior / compatibility changes**: Yes — a request that races tool
  registration now rides wire mode (proxy injects tools) instead of arriving
  tool-less. Sessions switch to pure plugin mode from the first request after
  registration. A dead manifest endpoint degrades to permanent wire mode.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `src/agent/pi.ts` — `RegisterState.toolsReady`; set in `registerTools()`
  after `pi.registerTool()` for every manifest tool; the stamping block in
  `before_provider_headers` is guarded by `if (state.toolsReady === true)`.
- `tests/plugin-agent.test.ts` — new regression test
  ("before_provider_headers does not claim plugin mode until tools are
  registered": empty headers before, full headers after registration); main
  test reordered (session_start + waitForTools before header assertions); omp
  entry test now drives registration against a real fake proxy instead of
  asserting on an unregistered plugin.

## 4. Testing & Verification

- typecheck ✅ · **533/533** tests ✅ (+2 net) · build ✅
- Real e2e (local SGLang 8199, anthropic protocol): one-shot
  `bili pi --model sglang-anthropic/qwen3.8-27b -p "reply with exactly: pong"`
  → round 1 `tools=[read,bash,edit,write,compress,decompress,search_context,acp_status]`
  (previously round 1 lacked the 4 ACP tools) → output `pong`, exit 0.
- Verified across all three protocols earlier in the session (openai chat /
  responses / anthropic), each on a fresh proxy port.

## 5. Rollback Plan

- Revert the single commit.

## 6. Lessons Learned

- A header that flips server behavior is an ownership claim — never make the
  claim before the resource it advertises exists. Async registration + sync
  stamping = classic lie-by-timing.
- The proxy's wire mode doubles as a natural fallback: deferring the claim
  converts a hard failure (tool-less session) into a seamless mode switch.
