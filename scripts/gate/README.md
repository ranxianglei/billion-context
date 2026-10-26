# Plugin Lanes (Lane P) — real host CLIs × real model

(中文版见 [README.zh-CN.md](./README.zh-CN.md))

These lanes drive billion-context's two activation paths with **real host CLIs**
(dsh / pi / codex / claude-code / opencode) and a **real model**, closing the
#3416 blind spot: the old gate only exercised proxy mode, so regressions like
#3401 ("plugin session has the tools on the wire, but the prompts were
silently switched off") sailed through the gate all green.

## Two activation paths

| Path | Hosts | Mechanism |
|------|-------|-----------|
| native | dsh, pi, opencode (v1/v2) | a thin plugin / native extension intercepts the host's fetch, stamps the `x-bili-plugin` header, and **self-spawns the proxy (port 0)** — never start a proxy externally |
| prefix | codex, claude | the host config points at the bili proxy's `/bili/` URL prefix (proxy mode); this script starts that proxy manually |

## What gets asserted (the wire is the source of truth)

`upstream-recorder.mjs` sits between bili and the real model and records every
request body / response as JSONL; every assertion is made on what the model
actually received — internal logs can be fooled by suppression-class bugs
(#3401), the wire cannot:

- upstream saw traffic (requests really reached the model)
- ACP tools (compress / acp_status / …) really appear in the wire's tools
- plugin claim: session file `payload.metadata.pluginAgent == "<agent>"`
- **hard nudge assertion**: the nudge text must appear on the wire (a "log
  shows INJECT" is not accepted — the injection can land in an in-band error
  response that is never forwarded; that is a fake green)
- fold fired (`acp-compress-obs] shrink N%`)
- codeword recall before/after the fold (corpus of 40 sections; S07 early /
  S40 last CODEWORDS markers)
- no `unknown tool` loops

## dsh protocol matrix (#3475)

dsh's model client (pi-ai) speaks all four common protocols, so the dsh lane
expands from one door to four — same headless driver, only the cordis provider
`api` and the baseURL suffix change; the t1→t4 flow and assertions are
unchanged:

| lane | pi-ai api | bili front door | upstream door required |
|------|-----------|-----------------|------------------------|
| `dsh` (original) | openai-completions | `/v1/chat/completions` | chat completions |
| `dsh-responses` | openai-responses | `/v1/responses` | a real `/v1/responses` (404 / mapping 400 → env-blocked) |
| `dsh-anthropic` | anthropic-messages | `/v1/messages` | `/v1/messages` (cross-checks the claude lane) |
| `dsh-google` | google-generative-ai | `/v1beta/models/<id>:streamGenerateContent` | a `/v1beta` google door |
| `dsh-proxy` | openai-completions (**proxy mode**) | `/bili/…/v1/chat/completions` | chat completions (via the `/bili/` prefix) |

`dsh-proxy` is the **other activation path** of the same host (owner add-on):
the profile does **NOT** load the billion-context bundle (its fetch intercept
would stamp `x-bili-plugin` and flip the lane back into plugin mode); dsh
drives the manually started proxy's `/bili/` URL directly — the same shape as
codex/claude. Contrasted with the native `dsh` lane within ONE script:
#3177/#3401-style suppression only exists on the plugin path; in proxy mode
nudge/fold must ride the wire with the acp_summary carrier; window truth =
bili.json (like every prefix lane).

Every door gains a **wire-shape hard assertion**: each recorder POST through
the door must match the protocol's path AND top-level body fields
(chat=`messages` / responses=`input` / anthropic=`system`+blocks /
google=`contents`) — a silent rewire must not read green; the first egress
request is dumped to `<work>/<agent>/egress-sample.json` as round-trip
evidence.

Two known facts:

- **bili does not translate google→chat on egress** — the recorder sees exactly
  the google shape dsh sends (`:streamGenerateContent` + contents/parts). The
  google lane can only go fully green against an upstream that has a real
  google door; requiring "it must come out as chat" would be a new
  egress-translation feature for bili — separate issue.
- **blocked demotion rules** (two kinds; the script prints an
  `ENV-BLOCKED`/`CLIENT-BLOCKED [lane] <reason>` line at the end):
  - **env**: the upstream door is unhealthy — ALL requests on the door are
    4xx/5xx/connection errors with no turn completed (the original
    opencode2/#3461 rule), OR degraded mid-flow (some 200s at first, then
    rejections, the flow never completes — the classic self-hosted
    responses→chat mapping-bug shape, #3461 sibling). Traffic + wire shape
    stay hard assertions; turn-dependent records drop out of the gate tally.
  - **client**: the client version cannot express the api at all (dsh
    ≤0.2.1-rc.1 cordis schema lists only openai-completions / openai-responses /
    anthropic-messages; google-generative-ai exists in the pi-ai library but
    dsh's config surface does not expose it) — zero upstream traffic + every
    turn dies on a ValidationError. The whole lane drops out of the gate; it
    auto-promotes when the client ships the protocol — no script change needed.

Not in the default GATE_AGENTS set; runs only when explicitly listed:
`GATE_AGENTS=dsh,dsh-responses,dsh-anthropic,dsh-google,dsh-proxy`.

## Lane flow

1. **t1 @ big window**: read the corpus, echo the S40 + S07 codewords (dual
   marker proves the corpus middle was really read — models may chunk-read or
   elide the middle, and an elided middle turns the later S07 recall assertions
   into false reds; fold must NOT fire in this phase)
2. **window shrink**: rewrite the **host's own** model config (dsh cordis /
   pi models.json / opencode.json limit / codex config.toml / claude model
   alias) — the effective window reaches bili via the
   `x-bili-plugin-context-window` header; native proxies keep a sticky zone
   port that re-reads it every request, no proxy restart needed
3. **t2 @ mid window**: S07 recall (intact context) + the hard nudge-on-wire
   assertion; the mid window self-calibrates from actual t1/t2 usage into the
   75–95% pressure band
4. **t3 @ small window**: "DONE" — the preflight fold must fire
5. **t4**: S07 recall after the fold

## How to run

Prerequisites: node ≥ 20, the host CLIs installed (dsh / pi / codex / claude /
opencode), one OpenAI-compatible real-model endpoint, and the candidate as an
`npm pack` tarball.

```sh
TGZ=/path/to/billion-context-x.y.z.tgz \
REPO=/path/to/billion-context-checkout \
MODEL1_BASE_URL=http://127.0.0.1:8199 \
MODEL1_MODEL=<model-id> \
GATE_AGENTS=dsh,pi,codex,opencode,claude \
node scripts/gate/plugin-lanes.mjs
```

- `GATE_AGENTS` selects a subset of lanes; `GATE_TURN_TIMEOUT_MS` (default
  300000), `GATE_BIG/MID/SMALL_WINDOW`, and `PLUGIN_LANES_WORK` (artifact
  dir, default `./plugin-lanes/`) are tunable
- dsh lanes: `GATE_DSH_VERSION` (each lane self-installs
  `@deepseek-ai/dsh@<v>`, default latest — system dsh may be too old and a
  global billion-context shadows the candidate bundle), `GATE_OUTPUT_TOKENS`
  (output budget: bili.json reservation + dsh cordis maxTokens, default 4096;
  raise it when a thinking model burns the whole budget on reasoning with no
  visible text), `GATE_DSH_SMALL_WINDOW` (fixed override of the t3 small
  window; by default derived from the live t2-end payload — dsh's fixed
  scaffolding is ~18k tok and a static 24576 minus the output reservation
  cannot fit even an empty session)
- per-lane artifacts: `<work>/<agent>/turn-t{1..4}.txt`, `upstream.jsonl`,
  `bili.log`, plus `<work>/<agent>/egress-sample.json` for the dsh family
- the opencode2 lane is not in the default set: transport websocket passes
  Responses-WS straight through (HTTP-only upstreams die on the handshake),
  and transport http depends on upstream `/v1/responses` quality — see
  #3461; the lane still asserts tools / claim / traffic
- **red/green contrast** (#3416 acceptance): a master build (carrying the
  #3401 bug) fails this lane with nudge wire MISSING / log:ARMED-SUPPRESSED;
  a build containing #3403 is all green

## Relation to the out-of-repo harness

The lane scripts live in this repo (versioned with the code under test); the
containerized wrapper (Dockerfile, verdaccio, custom image, model endpoints)
stays in its own gate-harness repo / machine and does not enter this repo.
Remote CI does not run by default: `.github/workflows/ci-gate-plugins.yml` is
workflow_dispatch-only, with no push/PR triggers.
