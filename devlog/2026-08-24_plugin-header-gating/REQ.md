# REQ - Plugin header gating (register before claiming ownership)

- Task ID: `2026-08-24_plugin-header-gating`
- Home Repo: `billion-context`
- Status: Accepted
- Created: 2026-08-24 17:20

## 1. One-liner

The pi/omp plugin must not stamp `x-bili-plugin` headers until its tools are
actually registered, otherwise the first provider request goes out with no ACP
tools at all.

## 2. Background

After the three-protocol matrix test on the local SGLang backend, a race was
observed in one-shot runs (`bili pi -p ...`):

- round 1 `tools=[read,bash,edit,write]` — no ACP tools
- round 2 `tools=[read,bash,edit,write,compress,decompress,search_context,acp_status]`

Root cause: `before_provider_headers` stamps `x-bili-plugin` synchronously but
fires `void registerTools(...)` without awaiting it. The header is what tells
the proxy "the client owns the ACP tools natively — skip wire injection". The
first request therefore left with neither native tools (manifest fetch still
in flight) nor wire-injected tools.

## 3. Requested Change

1. `src/agent/pi.ts` — only stamp the `x-bili-plugin*` headers when
   `registerTools()` has completed (a `toolsReady` flag on `RegisterState`).
2. Consequence (desired): before registration the request rides the proxy's
   wire mode — tools injected + native compress loop. After registration the
   session switches to pure plugin mode. A permanently failing manifest fetch
   degrades gracefully to permanent wire mode instead of a tool-less session.
3. Tests: a regression test asserting headers are NOT stamped before
   registration; existing tests reordered to register before asserting.

## 4. Acceptance Criteria

- One-shot `bili pi -p "..."` logs round 1 with the 4 ACP tools present.
- All existing tests pass; no new `as any` / `@ts-ignore`.

## 5. Out of Scope

- Any proxy-side changes (the fallback wire injection already exists).
- MCP bridge (`src/mcp.ts`) — tools/list is synchronous there, no race.
