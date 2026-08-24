# WORKLOG - Context window fixes

- Task ID: `2026-08-24_context-window-fixes`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-24 18:25

## 1. Summary

- **What was done**: refreshed the built-in context table (deepseek 64K→128K, minimax 204.8K added), taught the registry about minimax hosts, inverted the native-window priority so a warm models.dev cache outranks the stale static table, and closed the Web-UI config-clobber path (PUT 409 on unparseable file + parseError surfaced in GET/UI).
- **Why**: user report on #212 — DeepSeek out-of-the-box was stuck in emergency compression (64K vs real 128K+), MiniMax windows never resolved, and a hand-edited config with a JSON syntax error could be silently rebuilt from `{}` by a Web-UI save.
- **Behavior / compatibility changes**: Yes — native-window resolution order (registry-warm > table) and PUT /__bili/config now returns 409 instead of silently rewriting a broken config.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| this branch, tip | `fix(config): fresh context windows + registry priority + Web-UI config guard (#212)` |

### Key Files

- `src/config.ts` — CONTEXT_LIMIT_TABLE: `/^deepseek/i` 64_000→128_000; added `/^minimax/i`→204_800.
- `src/registry.ts` — HOST_TO_PROVIDER += api.minimax.chat / api.minimaxi.com / api.minimax.io; new `peekRegistryContext(model, host)` (sync, cache-only, never fetches) + shared `registryLookup` helper; `contextFromRegistry` refactored onto the helper.
- `src/server.ts` — native-window order is now: plugin header → `peekRegistryContext` (warm cache) → `resolveContextLimit` (user route decl → built-in table) → async `contextFromRegistry` fallback. Cold start is unaffected (peek misses synchronously).
- `src/web/api.ts` — new `configParseError()` (distinct: file exists + unparseable); `handleConfigGet` adds `parseError` field + warn log; `handleConfigPut` returns **409** before merging when the on-disk file is unparseable (refuses to rebuild from `{}`).
- `src/web/client.ts` — `loadConfig()` toasts the parseError so the user sees the exact path.
- `tests/registry.test.ts` (new, 7 tests) — minimax host mapping, boundary safety, cold/warm peek, provider-qualified keys, unusable entries skipped, reset helper.
- `tests/routing.test.ts` — deepseek 128_000, MiniMax-M2.1/minimax-m2 204_800 (two call sites).
- `tests/web-routing.test.ts` — new test: broken file → GET parseError + PUT 409 + file untouched; fixed syntax → PUT 200 + `modelContextLimit` survives.

## 4. Testing & Verification

- `npm run typecheck` ✅ · `npm test` **542/542** (+8) ✅ · `npm run build` ✅
- Data cross-checked against live models.dev (fetched 2026-08-24): deepseek-chat 1M (our table deliberately conservative at 128K — under-reporting is safe, the 400-overflow self-learning ratchets up), MiniMax-M2.1+ 204800, M3 512000.

## 5. Rollback Plan

- Revert the single commit.

## 6. Lessons Learned

- A static fallback table that OUTRANKS a live registry inverts the freshness hierarchy: the fallback becomes the authority and staleness becomes permanent. Fallbacks must lose to fresher sources whenever both are available cheaply (hence peek-only, no fetch on the hot path).
- "Read-modify-write" on a config file needs a parse-state guard: merging into `{}` when the read failed is the classic silent-data-loss path — refuse the write instead.
