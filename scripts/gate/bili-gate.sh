#!/usr/bin/env bash
# bili-gate.sh — config-driven launcher for the containerized real-model gate.
#
# The whole gate (image + lanes) lives in THIS directory. Host-specific facts
# (model endpoints, API keys, npm registry, git proxy/mirror, which rev to
# test) live ONLY in a local JSON config file that you pass with --config —
# nothing host-specific belongs in this repo (that is the contract the
# operator docs enforce for gate tooling).
#
#   usage: bili-gate.sh --config <path> [--rev REF] [--skip a,b,u,i,x,p,r]
#                                    [--keep] [--dry-run] [--help]
#
# Lanes (all on by default):
#   A compression | B model switch | U registry | I install | X auto-update
#   P host/plugin lanes (real CLIs) | R restart (kill matrix)
#
# See config.example.json for the full key list.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG=""
REV=""
SKIP=""
KEEP=0
CLI_KEEP=0
DRY=0
usage() { grep '^#   usage:' "$0" | sed 's/^#   //'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --rev) REV="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --keep) CLI_KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --help|-h) usage 0 ;;
    *) echo "unknown flag: $1" >&2; usage 1 ;;
  esac
done
[ -n "$CONFIG" ] || { echo "FATAL: --config <path> is required (see config.example.json)" >&2; exit 2; }
[ -f "$CONFIG" ] || { echo "FATAL: config file not found: $CONFIG" >&2; exit 2; }

# ---- parse the JSON config (node is a gate dependency everywhere) ----------
# jget <key> [default] — print config[key] or the default; with NO default
# argument the key is REQUIRED and a missing value fails fast (exit 2) before
# the expensive docker build. The has-default flag is passed explicitly because
# an unset $2 would otherwise collapse to "" (a string) and the required branch
# would never fire. The config file is passed by PATH and read inside node —
# never inlined into argv (the file may carry API keys, and "$(cat ...)" argv
# would expose them in ps during the parse window).
jget() {
  local key="$1" def="${2-}" hasdef=0
  if [ "$#" -ge 2 ]; then hasdef=1; fi
  node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const v = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), c);
  if (v === undefined) { if (process.argv[4] === "1") { console.log(process.argv[3]); } else { process.exit(3); } }
  else process.stdout.write(Array.isArray(v) ? v.join(",") : String(v));
' "$CONFIG" "$key" "$def" "$hasdef" || { echo "FATAL: config missing required key: $key (file: $CONFIG)" >&2; exit 2; }
}

M1_URL=$(jget model1.baseUrl)
M1_MODEL=$(jget model1.model)
M1_KEY=$(jget model1.apiKey "")
M2_URL=$(jget model2.baseUrl "")
M2_MODEL=$(jget model2.model "")
M2_KEY=$(jget model2.apiKey "")
REV=${REV:-$(jget rev "master")}
SKIP=${SKIP:-$(jget skip "")}
SRC_REPO=$(jget sourceRepo "https://github.com/ranxianglei/billion-context.git")
MIRROR=$(jget mirror "")
GIT_PROXY=$(jget gitProxy "")
NPM_REG=$(jget npmRegistry "https://registry.npmjs.org")
TURN_MS=$(jget turnTimeoutMs "300000")
AGENTS=$(jget agents "dsh,pi,codex,opencode,claude,dsh-google")
AGENTS_R=$(jget agentsR "dsh,pi")
SNAPBASE=$(jget snapBase "")
LANE_SCRIPT=$(jget laneScript "")
SNAP_RENDER=$(jget snapshotRender "")
R_CORPUS=$(jget r.corpusTokens "80000")
R_WINDOW=$(jget r.window "16384")
R_CAP=$(jget r.capRatio "0.4")
R_CACHE=$(jget r.cacheRatio "0.5")
NETWORK=$(jget network "host")
OUT_DIR=$(jget outDir "$PWD/out")
KEEP_CFG=$(jget keep "0")
if [ "$KEEP_CFG" = "true" ]; then KEEP=1; fi
if [ "$CLI_KEEP" = 1 ]; then KEEP=1; fi
MIRROR=${MIRROR/#\~/$HOME}
OUT_DIR=${OUT_DIR/#\~/$HOME}

# ---- source repo: local bare mirror (preferred) or direct fetch ------------
# A mirror lets the container clone without any network from inside (and
# works through host-side git proxies). Without one the container fetches
# GATE_REPO_URL directly (optionally through GATE_GIT_PROXY).
SRC_ARGS=()
if [ -n "$MIRROR" ]; then
  [ -d "$MIRROR" ] || { echo "FATAL: mirror dir not found: $MIRROR" >&2; exit 2; }
  for i in 1 2 3; do
    git --git-dir="$MIRROR" fetch origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' --prune >/dev/null 2>&1 && break
    echo "mirror refresh attempt $i failed — retrying"; sleep 5
  done
  git --git-dir="$MIRROR" rev-parse -q --verify "${REV}^{commit}" >/dev/null \
    || { echo "FATAL: mirror has no ref '$REV' after refresh (branch or tag)"; exit 2; }
  echo "mirror refreshed: $REV=$(git --git-dir="$MIRROR" rev-parse --short "${REV}^{commit}")"
  SRC_ARGS=(-v "$MIRROR:/gate/src-repo:ro" -e GATE_REPO_URL=/gate/src-repo)
else
  SRC_ARGS=(-e GATE_REPO_URL="$SRC_REPO")
fi
mkdir -p "$OUT_DIR"

# ---- docker run --------------------------------------------------------------
RUN=(docker run --rm "${SRC_ARGS[@]}")
if [ -n "$GIT_PROXY" ]; then RUN+=(-e GATE_GIT_PROXY="$GIT_PROXY"); fi
# GATE_SNAPBASE: run the P/R lanes with the candidate's egress op-log plane
# ON (rollout.features.egressPlane in the gate's bili.json; the retired
# storage.snapBase key no longer exists — ruling 7439, one switch for all
# protocol lanes). Value: "all" or a cohort list (any on-value = plane on).
# Must be appended AFTER the RUN=(...) init above — an earlier append is wiped
# by the reassignment.
if [ -n "$SNAPBASE" ]; then RUN+=(-e GATE_SNAPBASE="$SNAPBASE"); fi
# GATE_LANE_SCRIPT: force the P-lane harness script copy (e.g. the bundled
# /gate-tools/plugin-lanes.mjs when the candidate predates a harness fix —
# the entrypoint prefers the candidate's OWN scripts/gate copy when present).
if [ -n "$LANE_SCRIPT" ]; then RUN+=(-e GATE_LANE_SCRIPT="$LANE_SCRIPT"); fi
# GATE_SNAPSHOT_RENDER: force the candidate's snapshotRender egress body
# plane live in the P/R lane bili.json (config tier — the env tier never
# reaches the lane proxies because cleanEnv() strips BILI_* by design).
if [ -n "$SNAP_RENDER" ]; then RUN+=(-e GATE_SNAPSHOT_RENDER="$SNAP_RENDER"); fi
if [ "$NETWORK" = "bridge" ]; then
  RUN+=(--add-host=host.docker.internal:host-gateway)
else
  RUN+=(--network=host)
fi
RUN+=(-e MODEL1_BASE_URL="$M1_URL" -e MODEL1_MODEL="$M1_MODEL" -e MODEL1_API_KEY="${M1_KEY:-gate-local}" \
  -e MODEL2_BASE_URL="${M2_URL}" -e MODEL2_MODEL="${M2_MODEL}" -e MODEL2_API_KEY="${M2_KEY:-}" \
  -e NPM_CONFIG_REGISTRY="$NPM_REG" \
  -e GATE_TURN_TIMEOUT_MS="$TURN_MS" \
  -e GATE_AGENTS="$AGENTS" -e GATE_AGENTS_R="${AGENTS_R}" \
  -e GATE_R_CORPUS_TOKENS="$R_CORPUS" -e GATE_R_WINDOW="$R_WINDOW" \
  -e GATE_R_CAP_RATIO="$R_CAP" -e GATE_R_CACHE_RATIO="$R_CACHE" \
  -e GATE_CONCURRENT="${GATE_CONCURRENT:-1}" \
  -e GATE_P_CONC="${GATE_P_CONC:-4}" -e GATE_R_CONC="${GATE_R_CONC:-2}" \
  -v bili-gate-npm-cache:/root/.npm \
  -v "$OUT_DIR:/work" \
  -e GATE_REV="$REV" -e GATE_SKIP="$SKIP" -e GATE_KEEP="$KEEP" \
  -e GATE_UID="$(id -u)" -e GATE_GID="$(id -g)" \
  bili-gate)

if [ "$DRY" = 1 ]; then
  printf 'DRY-RUN: '; printf '%q ' "${RUN[@]}"; echo
  exit 0
fi

# ---- build the image (stale-image guard) ------------------------------------
# Lesson 2026-10-14: a build failure once got silently swallowed by the
# `build && echo` form (the &&-list exemption to set -e) and the gate ran an
# OLD image without a word. On failure we may reuse the existing image ONLY
# after proving its lane scripts are byte-identical to this working tree;
# any drift is FATAL — the gate must never run on stale lane logic.
LIVE_FILES="entrypoint.sh docker-lanes.mjs plugin-lanes.mjs restart-lanes.mjs wire-lanes.mjs upstream-recorder.mjs patch-gate.mjs verdaccio.config.yaml"
if ! docker build -q -t bili-gate . >/dev/null; then
  echo "WARN: docker build failed — verifying existing image before reuse" >&2
  stale_guard_ok=1
  for f in $LIVE_FILES; do
    in_img=$(docker run --rm --entrypoint md5sum bili-gate "/gate-tools/$f" 2>/dev/null | awk '{print $1}')
    on_host=$(md5sum "$f" | awk '{print $1}')
    if [ "$in_img" != "$on_host" ]; then
      echo "FATAL: image /gate-tools/$f differs from this tree — refusing to gate on stale lane logic" >&2
      stale_guard_ok=0
    fi
  done
  [ "$stale_guard_ok" = 1 ] || exit 3
  echo "image bili-gate reused (lane scripts verified identical)" >&2
else
  echo "image bili-gate up to date"
fi

exec "${RUN[@]}"
