# REQ — opencode launcher + /acp thin plugin

## Date
2026-08-23

## Background
`bili opencode` launch support was added (a349e34: launch client + `--bin` flag;
320b2fa: OPENCODE_CONFIG `/bili/` rewrite for plaintext HTTP upstreams). Two gaps
remained:

1. With opencode-acp self-disabled (upstream PR ranxianglei/opencode-acp#335),
   the user lost the `/acp` status command — the proxy's wire injection covers
   the model-facing tools, but nothing rendered a status panel.
2. Session binding: opencode cannot stamp `x-bili-plugin-*` headers from a
   plugin, so `handlePluginStatus` could not resolve the conversation to a
   proxy session.

## Requirements
1. `bili opencode` must surface an `/acp`-equivalent status panel with zero
   install steps and zero edits to the user's real `~/.config/opencode/opencode.json`.
2. The proxy's 4 wire-injected ACP tools must keep flowing to the model
   (compress/decompress/search_context/acp_status appended after opencode's
   native tools).
3. Real opencode config must remain byte-identical; all injection rides the
   throwaway `OPENCODE_CONFIG` temp file (existing pattern).

## Solution
- `src/agent/opencode.ts` — new 1.8KB thin plugin shipped in the package
  (`dist/agent/opencode.js`): registers the `acp` command (config hook +
  `command.execute.before`), fetches the proxy status panel, renders it via an
  ignored no-reply chat message (`client.session.prompt` + `parts[].ignored`,
  same mechanism opencode-acp uses). No-op unless `BILLION_CONTEXT_PROXY` is set.
- `prepareOpencodeHttpRewrite` takes an optional `pluginPath` and appends the
  absolute path of `dist/agent/opencode.js` to the temp config's `plugin`
  array (deduped; temp config is now emitted even when only a plugin rides
  along, including missing source config).
- `handlePluginStatus(conversationId, res, fallbackLatest)` — with
  `?fallback=latest`, an unknown conversation resolves to the most recently
  active session (`listSessions()` sorted by `lastSeen`). Response carries
  `fallback: true` so the caller can tell. Without the param the old 404
  behavior is unchanged.

## Non-goals
- Native tool registration inside opencode (its `tool` hook requires zod
  schemas; wire injection already covers the model surface).
- Exact conversation→session binding (no header hook used; latest-active
  fallback is correct for the single-session interactive flow).

## References
- Issue: bili opencode "看不到 acp 了" (user report after opencode-acp
  self-disable landed)
- Upstream: https://github.com/ranxianglei/opencode-acp/pull/335 (self-disable)
- Plugin API: `command.execute.before` + `config` hooks, `session.prompt`
  with `noReply`/`ignored` parts (mirrors opencode-acp's own notification path)
