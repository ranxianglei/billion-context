---
description: One-time setup — route Claude Code through the local billion-context proxy
allowed-tools: Bash(bili --version), Bash(npm install -g*billion-context*), Bash(bili plugin install claude*)
---

Run the native billion-context installer for the Claude Code lane, then tell the user to restart. Steps:

1. Check the CLI: run `bili --version`. If `bili` is not installed, first run `npm install -g billion-context --prefix=~/.local`.
2. Run the installer: `bili plugin install claude`.
3. Report exactly what the installer printed. It pins `ANTHROPIC_BASE_URL` to a local proxy in settings.json (a foreign value is never overwritten — it is reported instead), sets `DISABLE_AUTO_COMPACT=1` so billion-context owns compression, and registers the `/acp-cache` command plus the bili MCP tools.

Then instruct the user: **restart Claude Code** — the new environment takes effect on the next launch, and every message then flows through the local billion-context proxy, so month-long sessions compress automatically.

Notes:
- If the installer reported a foreign `ANTHROPIC_BASE_URL` was left untouched, tell the user to unset it (or set `BILI_CLAUDE_UPSTREAM` to the desired upstream) and run `/bili-setup` again.
- After restart, `/acp-cache` shows compression stats, and the `acp_status` MCP tool reports live state.
