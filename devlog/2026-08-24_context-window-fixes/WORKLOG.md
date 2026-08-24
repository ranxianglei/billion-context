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

## Follow-up: registry fetch was dead behind direct-only connections

User insight (verified correct): the registry never worked on this machine —
every log line was `could not load models.dev registry (offline + no cache)`
and the disk cache never existed. Root cause chain:

- models.dev is unreachable directly here (curl --noproxy: 000 timeout)
- the user shell has a working proxy (https_proxy=127.0.0.1:20172)
- but `fetchFresh()` used bare global `fetch`, and Node's fetch IGNORES
  http(s)_proxy env vars → permanent death → the stale built-in table was
  the ONLY live data source (which is why the stale limits mattered so much)

Fix (`src/registry.ts`): `fetchFresh()` now routes through the configured
upstream proxy when one exists — `proxyDispatcher(env https_proxy|HTTPS_PROXY
|http_proxy|HTTP_PROXY)` (cached undici ProxyAgent, same infrastructure the
model traffic uses) — and falls back to a direct attempt when no proxy is
configured or the proxied attempt fails. Reuses `fetchWithTimeout` (15s).
Self-loop safety: a proxy URL pointing at bili itself results in a CONNECT
blind-tunnel that fails once, then the direct fallback runs — no recursion.

Verification (real machine):
- node one-liner via ProxyAgent(20172): status 200, 355 models
- rebuilt dist → `start --port 8961` → one deepseek chat request →
  `[acp-registry] loaded models.dev (355 models, via proxy)`
- `~/.cache/billion-context/models-dev.json` written (288KB);
  deepseek-chat → 1,000,000; MiniMax-M2.1 → 204,800
- typecheck ✅ · 542/542 ✅

## Follow-up 2: bundled models.dev snapshot as the offline floor

User asked whether the downloaded registry is cached in-code for the
unreachable case. It was not — only the 17-entry regex table ships in the
package; the 355-model data lived solely in the runtime disk cache, which a
fresh install behind a dead network never obtains.

Layered fix:
- `scripts/update-registry-snapshot.mjs` (`npm run registry:snapshot`,
  proxy-aware like the runtime fetch, keeps the old file when offline) →
  slim `src/registry-snapshot.json` (351 models, 12 KB) committed to the
  repo and inlined into dist by tsup (verified: `MiniMax-M2.1` present in
  dist/index.js).
- `src/registry.ts`: the snapshot pre-warms the sync `peekRegistryContext`
  path at module load (identity check `cache !== snapshotReg` lets
  loadRegistry still upgrade past it — fresh disk cache and live fetch both
  outrank the build-time data). When a fetch fails, the newer of
  (stale disk cache by mtime, bundled snapshot by fetchedAt) wins
  (`newerFallback`, exported + unit-tested). `bundledSnapshotLookup()`
  exposed for tests/diagnostics.
- Fallback chain now: memory cache → fresh disk cache (24h) → live fetch
  (proxy first, direct fallback) → newer(stale disk, bundled snapshot) →
  built-in 17-entry regex table → 200k default.

Offline verification (no proxy env, disk cache deleted, fresh process):
  peek deepseek-chat@api.deepseek.com → 1,000,000   (was: undefined → 64k table)
  peek MiniMax-M2.1@api.minimax.chat  → 204,800
  unknown model                        → undefined (no guessing)
typecheck ✅ · 544/544 ✅ · build ✅ (dist 2.27 MB)

## Follow-up 3: full models.dev registry bundled (2026-08-24)

User asked whether the snapshot covers ALL of models.dev — it covered only
`limit.context` (12KB / 351 models). Directive: cache the ENTIRE models.dev
content, hard-coded into the package.

- `scripts/update-registry-snapshot.mjs` now writes the full registry:
  `{fetchedAt, count, models: <entire models.dev object>}` — 282KB / 355
  models with every field (name, description, family, attachment,
  reasoning, tool_call, temperature, knowledge, release_date,
  last_updated, modalities, open_weights, limit.context/output/input,
  weights, benchmarks, ...).
- `src/registry.ts`: `bundledSnapshotRegistry()` uses `snap.models` directly —
  full entries are structurally valid ModelEntry, extra fields ride along
  harmlessly (registryLookup still only reads `limit.context`, validated at
  lookup time). Added `bundledRegistryForTestsOnly()` escape hatch.
- New test: "bundled snapshot carries the FULL models.dev entry" — guards
  >=350 entries with >=300 having family / limit.output / reasoning+tool_call
  booleans, so a future slimming regression fails CI.
- dist grew 2.27MB -> 2.55MB (esbuild inlines the JSON as an object literal;
  verified `MiniMax-M2.1` + tool_call/benchmarks present).
- Offline re-verified (no proxy, no disk cache, fresh process):
  deepseek-chat -> 1,000,000 · MiniMax-M2.1 -> 204,800 · unknown -> undefined.
- Future features (pricing, modality checks, reasoning/tool_call flags) get
  the offline floor for free — today only limit.context is consumed.

typecheck ✅ · 545/545 ✅ · build ✅ (dist 2.55 MB)
