# REQ: `bili hermes` — bring hermes-agent under the proxy with zero config edits

## Date
2026-08-24

## References
- Issue #195 (Hermes 完整支持)

## Background

hermes-agent (Nous Research, Python) supports three LLM transports that all map
onto protocols the proxy already speaks:

| hermes `transport` | wire path |
|---|---|
| `openai_chat` (chat_completions) | POST /v1/chat/completions |
| `codex_responses` | POST /v1/responses |
| `anthropic_messages` | POST /v1/messages |

The launcher should bring hermes under the proxy with the same promise as every
other client: **read the client's own config, never edit it, route traffic
through the proxy, inject the four ACP tools.**

## Requirements

1. `bili hermes [opts --] [args]` spawns a fresh proxy and launches hermes
   against it; proxy dies with the client.
2. Zero edits to the user's real `~/.hermes/` — skills, memories, sessions,
   SOUL.md, `.env` stay shared.
3. Provider endpoints are discovered from `~/.hermes/config.yaml` (both the
   v12 `providers:` dict and the legacy `custom_providers:` list).
4. Every upstream — http AND https — rides the `/bili/` URL form (no cert
   MITM): hermes's httpx builds its CA bundle from certifi, so MITM would need
   trust config we cannot inject via env. The proxy terminates TLS upstream
   itself, so `/bili/https://...` needs no client-side cert at all.
5. Works with `HERMES_HOME` already set (hermes-native override respected).

## Non-goals
- No hermes-side plugin (hermes has no extension API; wire-mode tool injection
  covers it — verified end to end).
- `hermes acp` (Zed Agent Client Protocol) is unrelated to bili's ACP
  compression and out of scope.
