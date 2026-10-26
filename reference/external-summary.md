# External Summary Development Contract

Design discussion: [#2163](https://github.com/ranxianglei/billion-context/issues/2163), related to [#1640](https://github.com/ranxianglei/billion-context/issues/1640).

## Current Stage

The implementation in PR #2167 wires the isolated executor in `src/external-summary.ts` into the host's compression paths through `src/external-summary-runtime.ts` and `src/external-summary-compress.ts`. `compress.externalSummary` settings are opt-in and disabled by default; the chain is three-level like every other `compress` field (whole-chain replace at provider/model level, no sub-merge) and rides the request Config rail (`ctx.config` / `effectiveConfig`, #833) — there is no side configuration file. This is a review-branch implementation, not a published release or production deployment; repository-owner approval of the configuration surface remains outstanding.

The chain is expressed as **references** (`"glm/glm-4.9-flash"`) into named provider *recipes* in the `providers` table (non-URL entries carrying `baseUrl`/`api`/credential/`models`, see `CONFIGURATION.md`). Parsing is split: `src/external-summary-settings.ts` does syntax-level chain parsing at config load (`parseExternalSummaryChain`) and reference expansion at request-apply time (`expandExternalSummaryChain` / `expandExternalSummaryChainTolerant` in `src/compress-settings.ts`), producing the expanded `ExternalSummarySettings` the executor rail consumes. An unresolvable reference in an enabled chain logs one warning and disables the chain — never a fallback to the main model. The Web API saves reject unresolvable enabled chains with HTTP 400; recipes are collected from the about-to-be-saved `providers` section (`collectNamedProviders` in `src/config.ts`). #2336 adds an in-memory **agent-registry fallback layer** (`src/agent-providers.ts`): ACP-native agents POST their configured providers (`POST /__bili/agent-providers`, sanitized + validated by `parseAgentProviderReport`), and those recipes merge UNDER the file recipes at request-apply time (`{ ...agentProviderRecipes(), ...opts.namedProviders }`) — file wins on name collision. Agent recipes carry the resolved key inline (`apiKey` on the rail target, `XOR` with `credentialRef`; the file world still rejects plaintext keys — `parseExternalSummarySettings(value, { inlineKeys: true })` is the rail-only switch).

The executor accepts immutable task text, instructions and optional read-only reference text; an ordered list of injected asynchronous candidates; and explicit internal budgets. Wire protocols, authentication and range selection remain caller responsibilities. No provider request or fold occurs without a caller.

`src/external-summary-http.ts` provides single-attempt HTTP candidates for Anthropic, OpenAI Chat, Responses and Google. It reuses the existing summary codecs, with unchanged preflight behavior when disabled. An explicit resolved endpoint/model/header snapshot is used instead of main-request credentials. Reference data is carried separately from the selected content. Redirects, invalid UTF-8, excessive response bytes, missing completion markers, truncation and tool calls are rejected. SSE framing and completion are checked even when a relay changes the requested response format. HTTP and stream failures advance through the executor's existing target chain, with no independent retry loop. Hermetic tests use local mock upstreams; an opt-in live Responses smoke test also verified fact retention and exact original restoration. That smoke test is not a multi-provider quality or cost benchmark.

## Execution Contract

- Each candidate is invoked at most once per selected range, in order; the first valid result wins. Transport errors, empty output and excessive UTF-8 byte length advance to the next target. Byte-length validation is not semantic quality or token-window validation.
- Queue waiting consumes the total deadline; the per-target deadline starts after a permit is acquired. Both timers and monotonic elapsed-time checks reject late results. Blocking synchronous code cannot be preempted.
- Caller cancellation or the total deadline stops the chain. No partial/late summary is returned as success. Exhaustion never silently falls back to the main model.
- A shared executor bounds aggregate active calls across operations. A timed-out call that ignores abort retains its permit until it settles; this fails closed instead of launching unbounded background calls. Production adapters must actually cancel transport and release its resources.
- Reports include only target indexes and categorized outcomes, never raw provider error strings, keys, URLs or source history. The caller alone validates session revisions and commits successful ranges through the existing compression authority.

## Final Acceptance Scope

The internal `executeBatch` operation shares one monotonic deadline across queueing, all ranges and every fallback attempt. Results remain in input order; `finished` means every range was evaluated, not that every range succeeded. Cancellation or deadline stops later ranges and retains earlier results for an eventual caller to validate and commit. This operation does not commit folds or renew the timeout per range.

- An opt-in configuration-page section manages custom summary targets and ordered backups. The requester authorized implementation in the fork for review; this does not replace repository-owner approval of its public schema and secret storage before merge.
- Active `compress`, preflight, MCP/official thin-plugin execution and supported native-compaction summary generators use the common external service when enabled. A preflight-only implementation is not final delivery.
- The original main model continues its normal task after a successful fold; non-summary requests and the disabled mode preserve existing behavior.
- Multi-client/multi-host tests prove session separation, cancellation, stale-revision rejection, failure safety, credential isolation and tool-call byte fidelity in both proxy and plugin modes.
- Real API quality/cost comparisons require dedicated credentials and an approved spending limit; hermetic tests cannot substitute for those measurements.

The feature does not connect previously unrouted client history by itself. Model traffic and session identity must already reach Billion; MCP alone is insufficient. Credential setup for the shared summary service need not be duplicated for every main provider.

Stage completion requires reviewing new issue/PR feedback. In-goal refinements may proceed; changes that permanently remove a core requirement need renewed requester approval. No agent merge, npm publish or production deployment is part of this development stage.
