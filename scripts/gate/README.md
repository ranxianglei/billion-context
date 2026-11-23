# The real-model gate — container + lanes + config-driven launcher

(中文版见 [README.zh-CN.md](./README.zh-CN.md))

Everything the real-model release gate needs lives in this one directory: the
Docker image, the lane scripts, and a config-driven launcher. CI runs the
subset it can (Lane P, `ci-gate-plugins.yml`); the full container gate is for
operators with a real model endpoint and takes ~4-5h per round.

## What each lane proves

| Lane | Name | Proves | Driven by |
|---|---|---|---|
| A | compression | real model reads a corpus → window shrinks mid-session → **fold fires**, markers recalled from FOLDED context, cache recovers ≥50% | dsh headless (pi-based agent) |
| B | model switch | same session switches to a **different upstream/model** after the fold: lineage kept (or fork+adopted), cross-upstream baseline demoted, markers still recalled, new-upstream cache ≥75% | dsh headless |
| U | registry | dsh-managed proxy reads `update.registry`, refuses in-place self-update, "profile bundle up to date" | `scripts/release-gate-local.mjs` |
| I | install | `npm i -g <tarball> --install-links` = **true copy** (no symlink leak, #1225), CLI reports candidate version | `docker-lanes.mjs` |
| X | auto-update | publish a fake-newer build of the same commit → `bili update` **installs it** through `update.registry`, CLI lands on the new version | `docker-lanes.mjs` |
| P | host lanes | real host CLIs (dsh/dsh-google/pi/opencode/codex/claude — four client-side wires: openai-chat, google, responses, anthropic) through bili **plugin mode**: traffic hits the upstream, compress tools are live on the wire, nudge lands on-wire, fold fires + markers recalled (details below) | `plugin-lanes.mjs` |
| R | restart | a long session is first forced over its context wall (default 16384-token small window ⇒ fold with headroom; smaller walls are structurally infeasible — the folded steady state sits around ~20k tokens and preflight refuses turns it cannot bring under) while a real model answers; **claude** (opt-in via `agentsR`) adds the anthropic wire to the matrix — a prefix-topology lane where the harness-managed proxy child is killed and re-established on the same port, and the session must resume; then it is killed repeatedly and must keep working: **dsh** — the self-spawned proxy child is killed via kill -15 / kill -9 / clean shutdown, each respawn resumes the same session from disk, outbound stays well below raw-history size *and* above a bare-greeting floor (compact AND non-empty), exactly one live proxy holds the session (no split-brain); **pi** — the engine runs inline inside the pi CLI, so the kill matrix hits the pi host process itself mid-turn. A marker word from the recent zone is re-asked after every kill (evidence line — verbatim-through-fold quality is Lane A's assertion), and upstream `cached_tokens` must recover ≥50% of prior prompt tokens when reported | `restart-lanes.mjs` |

## The secret/endpoint contract

The gate is **fully hermetic inside the container** (own verdaccio on an
internal port, own DSH_HOME/XDG, own scratch) and every machine-specific fact
— model endpoints, API keys, npm registry, git proxy/mirror, which rev to
test — lives in a **local JSON config file that you keep outside this repo**.
Nothing host-specific (IPs, ports, relays, accounts, keys) may be committed
here; `config.example.json` shows the shape with placeholders only.

## How to run

Prerequisites: Docker (Linux host networking or Docker Desktop), a real
OpenAI-compatible model endpoint (Lane A), optionally a second DIFFERENT
upstream (Lane B; skipped when absent), and a local config file.

```sh
# 1. copy the example and fill in YOUR endpoints / keys / rev
cp config.example.json ~/system/bili-gate.json   # location is up to you
# 2. run the whole gate (one round ≈ 4-5h with real inference)
scripts/gate/bili-gate.sh --config ~/system/bili-gate.json --rev <branch-or-tag>

# common flags
scripts/gate/bili-gate.sh --config ... --skip u,i,x        # only A/B/P/R
scripts/gate/bili-gate.sh --config ... --keep              # keep scratch on green
scripts/gate/bili-gate.sh --config ... --dry-run           # print the docker command
```

Config keys (all optional except `model1.baseUrl` / `model1.model`):
`model1.{baseUrl,model,apiKey}`, `model2.{baseUrl,model,apiKey}` (Lane B),
`rev`, `skip`, `sourceRepo`, `mirror` (local bare git mirror the container
clones from — keeps container egress at zero and works behind host git
proxies), `gitProxy`, `npmRegistry` (deps mirror for the build; unrelated to
the in-container lane registry), `turnTimeoutMs`, `agents` (Lane P set),
`agentsR` (Lane R set; default `dsh,pi`, add `claude` for the anthropic-wire lane),
`snapBase` (P/R lanes only: run the candidate's EGRESS op-log plane ON in the
gate's bili.json — writes `rollout.features.egressPlane=true`; `storage.snapBase`
was retired in bc51c9445 and the plane has no per-protocol cohort, so any
on-value turns the whole plane on; absent/`"off"` = off, byte-identical gate;
for candidate-branch verification, e.g. #6785), `laneScript` (P lanes only: force a
specific harness-script copy, e.g. the bundled `/gate-tools/plugin-lanes.mjs` —
needed when the candidate checkout predates a harness fix; default is the
candidate's OWN `scripts/gate/plugin-lanes.mjs`, bundled copy as fallback),
`snapshotRender` (`"1"` writes `rollout.features.snapshotRender=true` into the
P/R lane bili.json — config tier, beats the 0% rollout default; plugin-mode
lanes stay client-authoritative by design), `r.{corpusTokens,window,capRatio,
cacheRatio}`, `network` (`host` | `bridge`; bridge is the Docker-Desktop
shape — point the config URLs at `host.docker.internal`), `outDir`, `keep`.

Concurrency: the P (plugin) and R (restart) lanes run SIDE BY SIDE by default
(their agents are fully isolated — per-lane recorder ports, XDG dirs, port
zones — and the shared upstream absorbs ~6 concurrent consumers). Tune via
host env vars passed straight into the container: `GATE_CONCURRENT` (default
`1`; set `0` to restore the legacy serial order — use it if a cache-recovery
assertion false-reds under concurrency and you need pristine cache isolation),
`GATE_P_CONC` (default `4`, in-flight P agents) and `GATE_R_CONC` (default `2`,
in-flight R agents).

Everything lands in `outDir` (mounted as `/work`): `gate-local.log`
(A/B/U), `plugin-lanes.log` (+ `plugin-lanes/<agent>/…`), `restart-lanes.log`,
`docker-lanes.log`, `verdaccio.log`, `gate-scratch/`. The launcher builds the
image first and, on build failure, refuses to reuse an existing image unless
every `/gate-tools/*` lane script is byte-identical to this working tree
(stale lane logic must never gate a release).

## Image notes

- **Keyed-API shims**: `patch-gate.mjs` guards-patches
  `scripts/release-gate-local.mjs` inside the container so the primary lane
  can carry a bearer key and probes treat any HTTP response as "up" (401/404
  from keyed gateways must not abort the lane). If the repo script drifts from
  the patcher's guarded patterns the build step fails loudly.
- **verdaccio runs inside the container** (Lanes U/I/X): zero host
  dependencies, ephemeral storage per run, internal port that cannot collide
  with any host registry.
- Host CLIs for Lane P are pinned in the image to the same versions the repo's
  own CI uses (`ci-e2e-pi-ws` / `ci-e2e-codex-persona` /
  `ci-e2e-native-opencode`), so the gate tests the same surfaces the project
  tests.

---

# Plugin Lanes (Lane P) — real host CLIs × real model

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
- plugin claim: session metadata `pluginAgent == "<agent>"` — read from
  `index.db` first (pure-SQLite is the storage default since 2026-11-13) with
  the JSONL envelope scan kept as fallback for older candidates
- **hard nudge assertion**: the nudge text must appear on the wire (a "log
  shows INJECT" is not accepted — the injection can land in an in-band error
  response that is never forwarded; that is a fake green)
- fold fired (`acp-compress-obs] shrink N%`)
- codeword recall before/after the fold (corpus of 40 sections; S07 early /
  S40 last CODEWORDS markers)
- no `unknown tool` loops

Lane R reads `cached_tokens` from the recorder's capped response-body tail
(usage lives in the final chunk); sensitive request headers are masked before
they hit the JSONL artifact.

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

Not in the default GATE_AGENTS set — runs only when explicitly listed (e.g.
`GATE_AGENTS=dsh,dsh-responses,dsh-anthropic,dsh-proxy`): `dsh-responses`,
`dsh-anthropic`, `dsh-proxy`. `dsh-google` IS in the default set — it degrades
to CLIENT-BLOCKED and is excluded from the tally when the client can't express
the protocol, so listing it there costs nothing.

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

## Running Lane P standalone (no container)

Prerequisites: node ≥ 20, the host CLIs installed (dsh / pi / codex / claude /
opencode), one OpenAI-compatible real-model endpoint, and the candidate as an
`npm pack` tarball.

```sh
TGZ=/path/to/billion-context-x.y.z.tgz \
REPO=/path/to/billion-context-checkout \
MODEL1_BASE_URL=<primary model base url> \
MODEL1_MODEL=<model-id> \
GATE_AGENTS=dsh,pi,codex,opencode,claude,dsh-google \
node scripts/gate/plugin-lanes.mjs
```

- `GATE_AGENTS` selects a subset of lanes; `GATE_TURN_TIMEOUT_MS` (default
  300000), `GATE_BIG/MID/SMALL_WINDOW`, `GATE_P_CONC` (in-flight agent cap,
  default 4), and `PLUGIN_LANES_WORK` (artifact dir, default `./plugin-lanes/`)
  are tunable
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

## Relation to CI

The lane scripts live in this repo, versioned with the code under test — the
container gate and the remote CI lane (`ci-gate-plugins.yml`,
workflow_dispatch-only, no push/PR triggers) run the SAME script from the
candidate checkout. The only thing that stays out of the repo is the local
config file carrying machine-specific endpoints and keys (contract above).
