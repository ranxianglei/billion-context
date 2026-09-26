# E2E: real codex client through bili against a real upstream

This suite runs the **real `codex` CLI** against a **real Responses-compatible
upstream** through the bili proxy, and asserts the full context-management
lifecycle end-to-end:

1. **warmup** — one turn; plants a known contamination value (`1400`) that the
   purity guard must later defeat.
2. **load growth** — `seq` tool outputs grow the payload deterministically
   (client-side; independent of model cooperation). Asserts `[acp-usage]`
   input grows.
3. **ACP compress** — under a small configured window the proxy must compress
   (model-cooperative `compress requested` **or** autonomous `preflight
   compressed`). Asserts usage drops after compression.
4. **purity** — post-compress recall of pre-compress facts (row counts of the
   `seq` runs) must be correct and must **not** echo the planted `1400`.
5. **forge** (gated by `E2E_FORGE=1`) — establishes an ACP block under an 8k
   window, then flips to a 16k window with a codex-side auto-compact limit
   below the ACP trigger so codex emits a **native compaction request**;
   asserts `codex compact intercepted … upstream not contacted`, a
   `fc_bili_` compaction item in the codex rollout, correct echo-stripping
   on the next turn, and intact recall after the forged compact.

## Running

```bash
npm run build                                  # suite spawns dist/index.js
ACP_TEST_E2E=1 node --import tsx --test tests/e2e/e2e-codex.test.ts
```

By default the suite **skips** (`set ACP_TEST_E2E=1`) so `npm test` stays free.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ACP_TEST_E2E` | – | `1` enables the suite |
| `E2E_UPSTREAM_URL` | `http://127.0.0.1:8199/v1` | Responses-compatible upstream (no `/bili/` prefix) |
| `E2E_UPSTREAM_KEY` | `bili-local-test` | API key passed via codex `env_key` |
| `E2E_MODEL` | `qwen3.8-27b` | model name |
| `E2E_BILI_DIST` | repo `dist/index.js` | proxy entry under test — point at any build for capability-matrix runs |
| `E2E_CODEX_BIN` | `codex` | codex binary |
| `E2E_FORGE` | – | `1` runs the forge phase (needs a dist with `BILI_CODEX_COMPACT` support, i.e. #325+) |
| `E2E_TMO` | `300000` | per-turn timeout ms |

Preflight (no tokens): `E2E_CHECK=1 node --import tsx --test tests/e2e/e2e-codex.test.ts`
prints codex version, dist path, and an upstream `/models` probe.

## Mechanics

- Full isolation: `CODEX_HOME`, `XDG_{CONFIG,CACHE,STATE}_HOME` and the work
  dir (`tmp/e2e-codex-*` in the repo — **not** `/tmp`, codex refuses TMPDIR
  homes) are throwaway. Codex's **spawn cwd** is deliberately OUTSIDE the repo
  tree (`$TMPDIR/billion-context-e2e*`): codex discovers `AGENTS.md` by walking
  up from its cwd, so an in-repo cwd folds the entire repo doc into every
  request payload and couples CI to doc size (#815). A stub `AGENTS.md` does
  NOT help — codex concatenates every level on the way up.
- The bili window is forced via the `BILI_LAUNCHER_MODEL_WINDOWS` env
  (per-model override; wins over registry peek) so compression triggers
  deterministically on every run, independent of the upstream's advertised
  window and of which window-alignment PRs are merged.
- Provider `name = "OpenAI"` in `config.toml` keeps codex on the remote
  compaction path (V2) so the forge phase exercises the real interception.
- Assertions scrape bili's own log lines (`[acp-usage]`, `preflight
  compressed`, `codex compact intercepted`, `stripped … bili compaction
  item(s)`) plus codex exit codes, `--output-last-message` answers, and the
  rollout JSONL.

## CI

`.github/workflows/ci-e2e.yml` runs the suite on `workflow_dispatch` with
`E2E_UPSTREAM_URL` / `E2E_UPSTREAM_KEY` from repository secrets, against the
repo's own `dist` (i.e. whatever is on master at dispatch time). It also
auto-runs on PRs whose diff touches the request-pipeline hot files
(`src/server.ts`, `src/server/**`, `src/loop/**`, `src/agent/**`, adapters/
stream/persist, `tests/e2e/**`, `package-lock.json`); events without secret
access (fork PRs) skip the run gracefully with a notice instead of failing.
The forge phase is enabled via the dispatch input `forge` (which sets the
`E2E_FORGE` env var) so it can be turned on once interception ships.


---

## Hermetic local npm registry (`ACP_TEST_REGISTRY`)

`e2e-registry.test.ts` exercises the **real self-update chain** — dist-tag
resolve → tarball download → sha512 verify → staged extract → in-place install
→ disk flip — plus post-update `plugin install opencode`, against a verdaccio
instance the suite **brings itself**. Loopback only; zero external network,
zero secrets, zero tokens (#1153).

## Running

```bash
npm run build                                  # fixture republishes dist as-is
ACP_TEST_REGISTRY=1 node --import tsx --test tests/e2e/e2e-registry.test.ts
```

By default the suite **skips** (`set ACP_TEST_REGISTRY=1`) so `npm test` stays
free (the `npm test` glob doesn't cover `tests/e2e/` anyway).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ACP_TEST_REGISTRY` | – | `1` enables the suite |
| `BILI_UPDATE_REGISTRY` | `https://registry.npmjs.org` | set by the suite per child process to the local registry URL |

## Mechanics

- **Own instance, always.** The fixture spawns its own verdaccio with an
  isolated storage dir and a throwaway HOME; it never points at an external
  (even internal) registry service — those are deployment environments, not
  test environments.
- **Random loopback port, read back.** The port comes from a `listen(0)`
  probe, never guessed or fixed (#360). Readiness is polled via `GET /-/ping`.
- **Crash-safe teardown.** `t.after` SIGTERMs the process; a 5s SIGKILL
  fallback covers wedged instances.
- **Authenticated publish.** verdaccio's anonymous publish is
  anonymous-*only* (`$anonymous`), which 403s the authenticated npm CLI — the
  fixture registers a local user via `PUT /-/user/org.couchdb.user:*`, drops
  the token into the isolated HOME's `.npmrc`, and uses `publish: $all`.
- **Fake install, real chain.** The "old version" is this repo's own files
  (per the `files` field) re-packed at a synthetic version, published under
  the same package name, and extracted under `<work>/global/node_modules/<pkg>`
  (the path shape matters: `isNpmInstallForm` keys off `node_modules`). The
  child process runs `dist/index.js update` with fully isolated
  `HOME`/`XDG_*` homes, so nothing touches the host.
- **Assertions scrape bili's real log lines** (`[update] checking npm
  registry for …`, `new version found: … downloading…`, `installed … → ….
  Restart to finish.`) plus the on-disk `package.json` flip, leftover
  staging/backup dirs, and lock release.
- **Deferred scenarios.** Zero-registry-round-trip resolution (#1108) and the
  `#1149` tag-cleanup regression are next up on this infra; the pinned-entry
  re-pin assertion lands with PR #1143 (marked in the test as `TODO(#1143)`).

## CI

`.github/workflows/ci-registry.yml` runs on every pull request: ubuntu-latest,
no secrets, `npm ci` + `npm run build` + the gated suite.

---

## Native-lane suite (`e2e-native-pi.test.ts`) — real `pi` package-native vs deterministic fake

`ACP_TEST_E2E_NATIVE=1` gates the suite (`npm test` stays free). It drives the
**real `pi` CLI** in package-native mode (the repo root installed as a pi
package — the `bili plugin install pi` lane) through a **deterministic
chat-completions fake upstream** (`fake-upstream-chat.mjs`, zero tokens), and
asserts the four user-facing guarantees of #1239:

1. **interception + plugin-mode claim** — every upstream request carries
   `x-bili-plugin: pi` + `x-bili-plugin-conversation` (the #1243 one-shot
   stamp race is asserted per request, not just on the first);
2. **`/acp` command works** — exit 0, no error strings, and the
   `/__bili/plugin/status` endpoint it consumes answers JSON;
3. **the model can call `acp_status`** — the tool is registered from request 2
   onward and its result (the status report) is re-sent in history;
4. **the model can call `compress` and compression actually happens** — the
   compress result reports the fold, the proxy logs the plugin-channel
   execution, and (after a graceful proxy stop) the persisted session carries
   ≥1 compressed block.

### Mechanics

- The fake upstream parses scripted directives (`请调用<tool>`,
  `请调用<tool> {json-args}`) out of the last user message and answers with
  real `tool_calls` shapes (stream + non-stream), so the scripted "model"
  drives pi's whole tool loop deterministically.
- Compression needs the target message OUTSIDE the kernel's protected zone
  (last 5 messages + most recent user message) and ≥5000 chars of
  compressible content: run one loads ~7.6KB of filler, run two
  (`--continue`) cites the run-one filler message in the scripted
  `compress` call.
- The suite spawns pi with a **hermetic `PI_CODING_AGENT_DIR`** (models.json
  pointing at the fake, settings.json loading the repo root as a package) and
  hermetic XDG dirs. `cleanEnv()` strips every bili side-channel
  (`BILLION_CONTEXT_PROXY`, `BILI_*`, `ACP_*`, host pi overrides) **and
  `NODE_TEST_CONTEXT`** — pi-native deliberately stands down inside
  node:test, and the runner exports that variable into every spawned child.
- The spawn cwd is outside the repo (#815, same reason as codex).
- Sessions persist lazily: the suite SIGTERMs the hermetic proxy
  (`stopProxiesGracefully`) before asserting on-disk state; teardown then
  SIGKILLs survivors (fake + instance-record pids).
- `E2E_CHECK=1` runs a zero-cost preflight (pi binary version, built
  `dist/agent/pi-native.js`, fake `/v1/models` probe). `E2E_PI_BIN` /
  `E2E_TMO` override the binary and per-run timeout.

### CI

`.github/workflows/ci-e2e-native.yml` runs the suite on every PR and on
`workflow_dispatch` with pi pinned (`pi-stable@0.83.6`), same discipline as
the codex pin (#815).

---

## Native-lane suite (`e2e-native-opencode.test.ts`) — real `opencode` plugin-native vs deterministic fake

`ACP_TEST_E2E_OC_NATIVE=1` gates the suite (`npm test` stays free). It drives
the **real `opencode` CLI** in headless `run` mode with bili's native plugin
(`dist/agent/opencode-native.js` — the self-spawn lane; V1 `.server()` on 1.x,
V2 `setup` on 2.x; `E2E_OC_BIN` picks the binary) through the **same
deterministic fake** (`fake-upstream-chat.mjs`, zero tokens), asserting the
same four #1239 guarantees on the opencode surface:

1. **interception + plugin-mode claim** — every upstream request (including
   the title side-channel call) carries `x-bili-plugin: opencode` +
   `x-bili-plugin-conversation: ses_…`;
2. **session binding + status reachable** — `/__bili/plugin/status` answers
   `{ok:true}` for the bound conversation while the proxy is alive (the `/acp`
   slash command itself is TUI-only — `run` dispatches no commands);
3. **the model can call `acp_status`** — host-side registration (zod interop
   on V1, tool-transform on V2) with the kernel status report re-sent in
   history;
4. **the model can call `compress` and compression actually happens** — the
   scripted call cites run-one filler's real ref tag, the result reports the
   fold, the follow-up request carries the plugin-mode carrier (tool call +
   result pair in history), the proxy logs the plugin-channel execution, and
   (after a graceful proxy stop) the persisted session carries ≥1 block.

### Mechanics (opencode-specific deltas vs the pi lane)

- Config is `$XDG_CONFIG_HOME/opencode/opencode.json` under hermetic XDG +
  HOME: a custom openai-compatible `fake` provider pointing at the fake plus
  the plugin entry — a bare dist path on 1.x, a wrapper directory (`index.js`
  re-export) on 2.x.
- v2 `run` rides a managed `serve --service` process on a channel-derived
  FIXED port; the suite pins `service.json` to a unique free port per context
  (collision-proof) and kills the recorded service pid in teardown.
- Both versions fire a side-channel title-generation request sharing the
  scripted queue key; the fake recognizes it (“You are a title generator” /
  “Generate a title…”) and answers inertly without touching queues.
- The compress target is harvested deterministically: the oracle records
  `lastUserRef` (the ACP tag prefix of the last user message), so the fold
  run cites run one's filler ref directly instead of guessing among example
  tags embedded in kernel prompt text. Two plain intermediate runs first push
  the filler outside the kernel's protected zone (last 5 messages + most
  recent user message).
- Between runs the suite waits (bounded) for the parent-watched proxy to
  exit, so no run races a mid-shutdown attach.
- Spawn cwd outside the repo tree (#815 — opencode walks up for AGENTS.md,
  and this repo's AGENTS.md carries literal `<acp>` examples) and hermetic
  `TMPDIR` (bun-based binaries scratch there; host `/tmp` can be read-only).
- `E2E_CHECK=1` runs a zero-cost preflight (binary version, built
  `dist/agent/opencode-native.js`, fake `/v1/models` probe). `E2E_OC_BIN` /
  `E2E_TMO` override the binary and per-run timeout.

### CI

`.github/workflows/ci-e2e-native-opencode.yml` runs the suite on every PR and
on `workflow_dispatch` with `@opencode/cli@2.0.3` pinned (V2 lane), same
discipline as the pi/codex pins (#815). The V1 lane (1.x) is exercised by the
same suite via `E2E_OC_BIN`.
