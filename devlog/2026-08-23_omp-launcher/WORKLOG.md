# WORKLOG - omp launcher support

- Task ID: `2026-08-23_omp-launcher`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-08-23 08:05

## 1. Summary

- **What was done** (1–3 sentences): Wired `omp` (oh-my-pi) into the `bili <client>`
  launcher so `bili omp` works like `bili pi`. omp is pi-based and honors
  `PI_CODING_AGENT_DIR`, so the existing pi isolated-home pattern is reused: the
  launcher reads `~/.omp/agent/models.yml` (never edits it), rewrites the HTTP
  providers' `baseUrl` to the `/bili/` prefix in a temp agent dir, whitelists HTTPS
  providers for MITM, and launches omp pointed at the proxy.
- **Why** (1–3 sentences): omp was only a plugin-install target, so omp users had to
  hand-edit `models.yml` to route through the proxy. The no-config launcher design
  already existed for pi/codex/claude; omp just wasn't wired in.
- **Behavior / compatibility changes**: Yes — `bili omp` is now a valid command. No
  change to the proxy's wire protocol, config schema, or the real omp config files.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `192dcda` | feat: add omp to the bili launcher (no-config /bili/ rewrite + MITM) |

### Key Files

- `src/client-config.ts` — added `OmpProvider`/`OmpConfig` types, `resolveOmpHome`
  (`PI_CODING_AGENT_DIR` → `~/.omp/agent`), `parseOmpYaml` (targeted line-based YAML
  reader for `providers.<name>.baseUrl`, mirrors `parseCodexToml`), `readOmpConfig`;
  wired `config.omp` into `loadClientConfig`.
- `src/launcher.ts` — `omp` added to `LAUNCH_CLIENTS` + `BaseClientName`;
  `launcherInjectMcp` now excludes omp (native extension, not MCP); `discoverRoutes`
  omp branch; new `prepareOmpHttpRewrite` (line-based `models.yml` rewrite + symlink
  siblings, mirrors `preparePiHttpRewrite`); `runLaunch` omp env branch
  (`buildPiEnv` + `prepareOmpHttpRewrite` + `PI_CODING_AGENT_DIR`) + temp-dir cleanup.
- `src/cli.ts` — help text lists `bili omp` (usage line + launcher section + example).
- `tests/launcher.test.ts` — 8 new tests (parseOmpYaml ×2, readOmpConfig ×2,
  resolveOmpHome, discoverRoutes omp, prepareOmpHttpRewrite ×3) + `isLaunchClient`
  updated to assert `omp === true`.

## 3. Design & Implementation Notes

- **Entry point / key function**: `prepareOmpHttpRewrite(ompHome, origin,
  httpRewrites, httpsRewrites)` in `src/launcher.ts`. It reads `models.yml`, walks the
  `providers:` block by indentation, and rewrites only the `baseUrl:` line of each
  provider present in `httpRewrites` (→ `wrapUpstream(origin, realUpstream)`) or
  `httpsRewrites` (→ raw upstream for cert-MITM). Leading indent and any trailing
  `# comment` are preserved. It then `mkdtemp`s a `bili-omp-*` dir, symlinks every
  real-home entry except `models.yml` (so sessions/cache/dbs are shared, not
  isolated), and writes the rewritten `models.yml`.
- **Key configuration items**: `~/.omp/agent/models.yml` (providers),
  `~/.omp/agent/config.yml` (extensions incl. `dist/agent/omp.js`, modelRoles).
- **Key logic explanation**: omp is pi-based, so it reads its agent dir from
  `PI_CODING_AGENT_DIR`. Pointing that at the temp dir makes omp use the rewritten
  `models.yml` while sharing all other state via symlinks. The real `models.yml` is
  never touched (user hard requirement). HTTPS providers (e.g. zhipuai) are not
  rewritten — they go through cert-MITM via `HTTPS_PROXY` + the proxy CA, which is why
  the launcher whitelists their hostnames and (when the running proxy lacks them)
  spawns a fresh proxy.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck      # tsc --noEmit --project tsconfig.build.json
npm test               # node --import tsx --test tests/*.test.ts
npm run build          # tsup
```

### Test Coverage

- New/modified test files: `tests/launcher.test.ts`
- Test count: 523 total, 523 pass, 0 fail (was 515 before; +8 new)
- Key scenarios verified:
  - `parseOmpYaml` extracts `providers.<name>.baseUrl` and skips non-matching keys.
  - `readOmpConfig` reads `models.yml`; returns `{}` when missing.
  - `resolveOmpHome` honors `PI_CODING_AGENT_DIR`, defaults to `~/.omp/agent`.
  - `discoverRoutes("omp", …)` splits http/https providers correctly.
  - `prepareOmpHttpRewrite` rewrites the target provider, leaves others, symlinks
    siblings; returns `undefined` when no rewrites or `models.yml` missing.

### Results

- **PASS/FAIL**: PASS
- **Key logs/data** (optional): live end-to-end run
  `node dist/index.js omp -p "reply with exactly: pong"` →
  `bili: started proxy at http://127.0.0.1:44353 (MITM domains: open.bigmodel.cn)
  (HTTP /bili/ rewrites: 6)` → omp returned `pong` → proxy log
  `forward POST → http://127.0.0.1:8199/v1/responses` (traffic routed through the
  proxy to the real SGLang backend) with the 4 ACP tools injected. Real
  `~/.omp/agent/models.yml` confirmed untouched (0 `/bili/` occurrences); spawned
  proxy killed and temp dir removed on client exit.

## 5. Risk Assessment & Rollback

- **Risk points**: `parseOmpYaml` is a targeted reader (string `baseUrl` values only);
  a non-standard `models.yml` layout would be skipped, not corrupted (line-based
  rewrite only touches matched `baseUrl:` lines).
- **Rollback method**:
  - Revert commit(s): `192dcda`
  - Rollback impact: `bili omp` becomes `unknown command` again; no other behavior
    changes.
- **Compatibility notes** (data format, config schema): No — no proxy config schema or
  wire-protocol changes; the real omp config files are never modified.

## 6. Lessons Learned (optional)

- What went well: omp being pi-based meant the entire pi isolated-home pattern
  (`preparePiHttpRewrite` + `PI_CODING_AGENT_DIR`) transferred directly; only the
  config file format (YAML vs JSON) needed a new targeted reader.
- What could be improved: running the launcher from source (`node --import tsx
  src/index.ts omp`) fails because the spawned proxy child uses `process.argv[1]`
  (the TS source) with plain `node`; test the launcher from the built `dist/index.js`.
- Reusable conclusions: for any future pi-based client, adding it to the launcher is
  (1) a config reader in `client-config.ts`, (2) a `discoverRoutes` branch, (3) a
  `prepare*HttpRewrite` for its config format, (4) a `runLaunch` env branch reusing
  `buildPiEnv` + `PI_CODING_AGENT_DIR`.

## 7. Follow-ups (optional)

- [ ] Consider a `bili test omp` smoke-test command (currently pi-test is pi-only).
- [ ] Consider reusing a running proxy when its MITM whitelist already covers the
      discovered domains (currently a fresh proxy is spawned if the default-port proxy
      lacks them).
