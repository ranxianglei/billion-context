# REQ - Context window fixes (stale table, missing minimax, config clobber)

## Background

User feedback on issue #212 (comment by stirp):

1. After an npm install, `~/.config/billion-context/billion-context.json` appeared to be overwritten (custom fields lost).
2. Default DeepSeek context seemed to be only 64K — out of the box, sessions hit emergency compression constantly.
3. MiniMax model sizes were missing entirely.

## Problem Statements

### P1 — config overwrite
`handleConfigPut` rebuilt the config from `{}` when the on-disk file failed to parse (hand-edited comment / trailing comma → `safeReadJson` → null → `readConfig()` → `{}`), silently wiping every unreadable field. "npm install" was coincidental timing — the loss happened on the next Web-UI save.

### P2 — DeepSeek stuck at 64K
`CONTEXT_LIMIT_TABLE` pinned `/^deepseek/i → 64_000` (V2-era data; models.dev now lists deepseek-chat at 1M, v3.2 at 128K). Worse, the built-in table OUTRANKED the models.dev registry, so fresh data could never win — a stale table locked emergency compression in forever.

### P3 — MiniMax absent
No `/^minimax/i` table entry AND no `api.minimax.chat` / `api.minimaxi.com` mapping in `HOST_TO_PROVIDER`, so registry keys like `minimax/MiniMax-M2.1` (204800) never matched. Fell to the global 200K default.

## Requirements

1. Never silently rebuild an unparseable config from `{}` — refuse the PUT, tell the user.
2. DeepSeek default must stop triggering constant emergency compression.
3. MiniMax windows must resolve (table entry + registry host mapping).
4. Stale-table lock-in must not recur: a warm registry cache outranks the static table.

## Constraints

- No new runtime dependencies.
- No behavior change for the priority of user-configured per-route declarations and `compress.modelContextLimit` operator tuning.
- Cold start must not block on a registry fetch.

## Scope

- `src/config.ts` — CONTEXT_LIMIT_TABLE entries
- `src/registry.ts` — HOST_TO_PROVIDER, peekRegistryContext
- `src/server.ts` — native-window resolution order
- `src/web/api.ts` + `src/web/client.ts` — parseError surfacing + PUT guard
- tests — routing, registry (new file), web-routing

## Relations

- Issue: https://github.com/ranxianglei/billion-context/issues/212 (comment feedback)
