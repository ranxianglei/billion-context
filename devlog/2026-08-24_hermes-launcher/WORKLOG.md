# WORKLOG: `bili hermes`

Branch: `2026-08-24_hermes-launcher` (single commit on top of master f391a3e)

## 1. Why `/bili/` for everything (no cert MITM)

Hermes is a Python/httpx client: `httpx` builds its SSL context from
`certifi` explicitly, so `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` are ignored —
cert-MITM cannot be trusted via env alone. Wrapping every upstream (http and
https) in the `/bili/` URL form sidesteps TLS entirely on the client leg; the
proxy does TLS to the real upstream itself. Same decision as claude (whose
undici also ignores HTTPS_PROXY).

## 2. Implementation

- `src/client-config.ts`: `HermesProvider`/`HermesConfig`, `resolveHermesHome`
  (HERMES_HOME → ~/.hermes), `parseHermesYaml` (line-based: v12 `providers:`
  dict → `api:` per provider; legacy `custom_providers:` list → `- name:` /
  `base_url:`/`api:`/`url:`; inline keys on dash lines handled),
  `readHermesConfig`; wired into `loadClientConfig`.
- `src/launcher.ts`:
  - `LAUNCH_CLIENTS`/`BaseClientName` += hermes; `launcherInjectMcp` excludes
    hermes (no MCP injection — wire mode owns the tools).
  - `discoverRoutes` hermes branch: every provider endpoint → `httpRewrites`
    (https too), `httpsDomains` stays empty.
  - `prepareHermesHome(hermesHome, origin, rewrites)`: mkdtemp
    `bili-hermes-*`, symlink every `~/.hermes` sibling except `config.yaml`
    (skills/memories/sessions shared), rewrite every
    `api:`/`base_url:`/`url:` line whose URL matches a discovered upstream to
    `origin + /bili/ + raw` (comment suffix preserved). Returns temp dir;
    `HERMES_HOME` is pointed at it.
  - runLaunch: hermes branch + temp-dir cleanup in `finally`; warns when no
    providers were found (traffic would bypass the proxy).
- `src/cli.ts`: usage lines + launcher section + example.
- `tests/launcher.test.ts`: +4 tests (parse v12+legacy, read+resolve,
  discoverRoutes wrap-both-schemes/no-MITM, prepareHermesHome rewrite/share/
  untouched-original/empty-rewrites).

## 3. Verification

- `npx tsc --noEmit` clean; `npm test` 557/557 (was 553, +4); build ok.
- Real e2e (isolated HERMES_HOME + SGLang qwen3.8-27b on 127.0.0.1:8199), all
  three transports:
  - `openai_chat` → `forward POST → /v1/chat/completions`, pong.
  - `codex_responses` → `forward POST → /v1/responses`, pong.
  - `anthropic_messages` → `forward POST → /v1/messages`, pong.
  - In every run the model's tool list ended with
    `compress, decompress, search_context, acp_status` (28 hermes built-ins +
    4 injected), `acp-loop round 1` healthy, no tool-call loops.
  - Hermes's startup model probing (GET /v1/models, /api/tags, /api/show,
    /api/v1/models) is passed through verbatim by the proxy.
  - The source config.yaml kept its raw `api: http://127.0.0.1:8199/v1`
    (untouched); no `bili-hermes-*` temp dirs left behind.

## 4. Rollback

Revert the single commit; no data migrations, no config-format changes.

## 5. Notes / gotchas

- hermes `--provider custom` on the CLI is a placeholder profile that routes
  to openrouter unless completed by config — irrelevant here because the
  launcher rewrites the user's real config instead.
- `HERMES_HOME` env is respected by both sides (hermes + launcher), so e2e
  could run against a throwaway home without touching `~/.hermes`.
- Upstream forbids wheel/sdist builds (setup.py guard); the supported local
  install is a clone + `uv venv` + editable install (see ~/system/README.md
  "Hermes Agent").
