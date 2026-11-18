#!/usr/bin/env bash
# entrypoint.sh — orchestrates the whole container run:
#   0. preflight env
#   1. clone + build the repo under test (GATE_REV of GATE_REPO_URL)
#   2. npm pack the candidate tarball
#   3. start in-container verdaccio (install/update lanes need no host services)
#   4. shim scripts/release-gate-local.mjs for keyed model APIs (guarded patches)
#   5. run the real-model gate (Lane A compression / Lane B switch / Lane U registry)
#   6. run container-only lanes (Lane I install / Lane X auto-update bump)
# Exit code: non-zero if any lane is red.
set -uo pipefail

log() { printf '\n===== %s =====\n' "$*"; }
sub() { printf -- '--- %s\n' "$*"; }

WORK=/work
REPO=/gate/repo
SCRATCH=$WORK/gate-scratch
mkdir -p "$WORK"

# ---- 0. preflight -----------------------------------------------------------
log "0. preflight"
: "${MODEL1_BASE_URL:?MODEL1_BASE_URL is required (OpenAI-compatible base, e.g. http://host.docker.internal:8199 or https://api.example.com/v1)}"
: "${MODEL1_MODEL:?MODEL1_MODEL is required (model id on that base)}"
MODEL1_API_KEY=${MODEL1_API_KEY:-gate-local}
SKIP=${GATE_SKIP:-}
if [ -z "${MODEL2_BASE_URL:-}" ] || [ -z "${MODEL2_MODEL:-}" ]; then
  sub "MODEL2_* not set — model-switch lane (B) will be skipped"
  SKIP="${SKIP:+$SKIP,}b"
fi
echo "primary   : $MODEL1_BASE_URL  model=$MODEL1_MODEL  key=${MODEL1_API_KEY:0:4}…"
echo "secondary : ${MODEL2_BASE_URL:-<none>}  model=${MODEL2_MODEL:-<none>}"
echo "repo      : $GATE_REPO_URL @ ${GATE_REV}"
echo "registry  : ${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org} (deps)"
# release-gate-local takes its skips as a CLI flag (--skip a,b,u), not via
# env — GATE_SKIP above only reaches the P/R/I/X scripts. Forward the a/b/u
# subset here; i/x/p/r are handled by those scripts themselves.
ABU_SKIP=""
if [ -n "$SKIP" ]; then
  for k in ${SKIP//,/ }; do
    case "$k" in a|b|u) ABU_SKIP="${ABU_SKIP:+$ABU_SKIP,}$k" ;; esac
  done
fi
echo "skip      : ${SKIP:-none}"

node --version; npm --version; git --version; dsh --version || true

# ---- 1. clone + build -------------------------------------------------------
log "1. clone + build"
# bind-mounted source repos trigger git's dubious-ownership guard in containers
git config --global --add safe.directory '*'
rm -rf "$REPO"
git init -q "$REPO"
git -C "$REPO" remote add origin "$GATE_REPO_URL"
sub "fetching $GATE_REV (depth 1)…"
GIT_PROXY_ARGS=()
if [ -n "${GATE_GIT_PROXY:-}" ]; then GIT_PROXY_ARGS=(-c "http.proxy=$GATE_GIT_PROXY"); fi
git -C "${REPO}" "${GIT_PROXY_ARGS[@]}" fetch --depth 1 origin "$GATE_REV" || { echo "FATAL: fetch failed"; exit 2; }
git -C "$REPO" checkout -q FETCH_HEAD
git -C "$REPO" log --oneline -1
REV_SHA=$(git -C "$REPO" rev-parse --short HEAD)

sub "npm ci"
npm ci --no-audit --no-fund --prefix "$REPO" || { echo "FATAL: npm ci failed"; exit 2; }
sub "npm run build"
npm run build --prefix "$REPO" || { echo "FATAL: build failed"; exit 2; }

# ---- 2. pack ----------------------------------------------------------------
log "2. npm pack candidate"
rm -f "$WORK"/billion-context-*.tgz
( cd "$REPO" && npm pack --pack-destination "$WORK" >/dev/null ) || { echo "FATAL: pack failed"; exit 2; }
TGZ=$(ls "$WORK"/billion-context-*.tgz | head -1)
V=${TGZ##*billion-context-}; V=${V%.tgz}
echo "candidate : billion-context@$V ($REV_SHA) -> $TGZ"

# ---- 3. verdaccio ------------------------------------------------------------
log "3. in-container verdaccio (install/update lanes)"
# Distinct port (4874): never collides with a host verdaccio on 4873 under
# --network=host, and never gets confused with it either.
VDC_PORT=${VDC_PORT:-4874}
VDC_URL=http://127.0.0.1:$VDC_PORT
rm -rf /tmp/verdaccio-storage
sed "s/127.0.0.1:4873/127.0.0.1:$VDC_PORT/" /gate-tools/verdaccio.config.yaml >/tmp/verdaccio.config.yaml
nohup verdaccio --config /tmp/verdaccio.config.yaml >"$WORK/verdaccio.log" 2>&1 &
VDC_PID=$!
for i in $(seq 1 30); do
  curl -sf $VDC_URL/-/ping >/dev/null && break
  sleep 1
done
curl -sf $VDC_URL/-/ping >/dev/null || { echo "FATAL: verdaccio did not come up (see $WORK/verdaccio.log)"; exit 2; }
# bootstrap a publish user (same recipe as the host registry)
cat >/tmp/vdc-user.json <<EOF
{"_id":"org.couchdb.user:gate","name":"gate","password":"gate-pass-1","email":"gate@localhost","type":"user","roles":[]}
EOF
VDC_TOKEN=$(curl -s -X PUT -H 'content-type: application/json' --data-binary @/tmp/vdc-user.json \
  $VDC_URL/-/user/org.couchdb.user:gate | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).token||"")}catch{console.log("")}})')
if [ -z "$VDC_TOKEN" ]; then echo "FATAL: verdaccio adduser failed"; exit 2; fi
cat >"$WORK/verdaccio.npmrc" <<EOF
registry=$VDC_URL/
//127.0.0.1:$VDC_PORT/:_authToken=$VDC_TOKEN
EOF
echo "verdaccio up on $VDC_URL (pid $VDC_PID), publish user ok"
# Pre-publish the candidate BEFORE the gate starts: the profile proxy's first
# update check happens at proxy start (then every 180s with failure backoff),
# and the gate's Lane-U assertion needs a startup check that already finds
# latest=candidate on the registry.
sub "pre-publishing candidate to the lane registry"
npm publish "$TGZ" --userconfig "$WORK/verdaccio.npmrc" --registry "$VDC_URL" >/dev/null 2>&1 || {
  echo "FATAL: pre-publish of candidate failed — Lane U startup check would probe a registry without the candidate"
  exit 2
}

# ---- 4. shim the gate for keyed APIs -----------------------------------------
log "4. patch release-gate-local.mjs (keyed-API shims)"
node /gate-tools/patch-gate.mjs "$REPO/scripts/release-gate-local.mjs" || {
  echo "FATAL: gate shim patch failed — release-gate-local.mjs drifted from the patcher's guarded patterns"
  exit 2
}

# ---- 5. real-model gate -------------------------------------------------------
log "5. release-gate-local (lanes A compression / B switch / U registry)"
rm -rf "$SCRATCH"
KEEP_FLAG=""
[ "${GATE_KEEP:-0}" = "1" ] && KEEP_FLAG="--keep"
set +e
env \
  GATE_DSH_BIN=dsh GATE_PNPM_BIN=pnpm \
  GATE_SGLANG_URL="$MODEL1_BASE_URL" \
  GATE_SGLANG_MODEL="$MODEL1_MODEL" \
  GATE_PRIMARY_KEY="$MODEL1_API_KEY" \
  GATE_RELAY_URL="${MODEL2_BASE_URL:-}" \
  GATE_RELAY_MODEL="${MODEL2_MODEL:-}" \
  GATE_RELAY_KEY="${MODEL2_API_KEY:-gate-relay}" \
  GATE_VERDACCIO=$VDC_URL \
  GATE_VERDACCIO_NPMRC="$WORK/verdaccio.npmrc" \
  GATE_SKIP="$SKIP" \
  node "$REPO/scripts/release-gate-local.mjs" \
    --tarball "$TGZ" --base-dir "$SCRATCH" --with-update $KEEP_FLAG \
    ${ABU_SKIP:+--skip "$ABU_SKIP"} \
  2>&1 | tee "$WORK/gate-local.log"
RC_GATE=${PIPESTATUS[0]}

# ---- 5.5 + 5.7 plugin (P) + restart (R) lanes, concurrent ------------------
# P and R are fully independent (per-lane recorder ports, XDG dirs, per-agent
# port zones) and each of their agents is one model consumer at a time, so
# the two lane groups run SIDE BY SIDE: their internal agent pools are capped
# (GATE_P_CONC default 4 + GATE_R_CONC default 2 ≈ 6 concurrent consumers,
# the shared upstream's comfortable headroom). Lane I/X (section 6) still
# waits: its registry publishes must not race the lanes' update probes.
# GATE_CONCURRENT=0 restores the legacy serial order — use it if you need
# pristine cache isolation for measurement-sensitive assertions.
log "5.5 plugin + 5.7 restart lanes (concurrent)"
CONCURRENT=${GATE_CONCURRENT:-1}
P_PID=""; R_PID=""
# Fresh per-run rc files: a stale copy left in a persistent outDir by an
# earlier run must never be read back if the subshell dies before its final
# echo (that failure direction HIDES a red in release verification).
rm -f "$WORK/.rc-plugins" "$WORK/.rc-restart"
if echo ",${SKIP}," | grep -q ",p,"; then
  sub "GATE_SKIP contains p — plugin lanes skipped"
  RC_PLUGINS=0
else
  # Prefer the candidate repo's OWN lane script when present (newer candidates
  # ship it — #3462); fall back to the bundled copy for older candidates
  # (e.g. v0.1.197) that predate scripts/gate/. GATE_LANE_SCRIPT forces a
  # specific copy (e.g. /gate-tools with fixes not yet merged into master).
  PL="${GATE_LANE_SCRIPT:-}"
  for cand in "$PL" "$REPO/scripts/gate/plugin-lanes.mjs" /gate-tools/plugin-lanes.mjs; do
    if [ -n "$cand" ] && [ -f "$cand" ]; then PL="$cand"; break; fi
  done
  [ -n "$PL" ] || { echo "plugin-lanes.mjs not found"; exit 1; }
  echo "plugin-lanes: using $PL"
  P_ENV=(TGZ="$TGZ" REPO="$REPO" WORKDIR="$WORK"
    MODEL1_BASE_URL="$MODEL1_BASE_URL" MODEL1_MODEL="$MODEL1_MODEL" MODEL1_API_KEY="$MODEL1_API_KEY"
    GATE_AGENTS="${GATE_AGENTS:-dsh,pi,codex,opencode,claude,dsh-google}"
    GATE_TURN_TIMEOUT_MS="${GATE_TURN_TIMEOUT_MS:-300000}"
    GATE_OC2_BIN="${GATE_OC2_BIN:-}" GATE_OC1_BIN="${GATE_OC1_BIN:-}")
  if [ "$CONCURRENT" = "1" ]; then
    ( env "${P_ENV[@]}" node "$PL" 2>&1 | tee "$WORK/plugin-lanes.log"
      echo "${PIPESTATUS[0]}" > "$WORK/.rc-plugins" ) &
    P_PID=$!
  else
    env "${P_ENV[@]}" node "$PL" 2>&1 | tee "$WORK/plugin-lanes.log"
    RC_PLUGINS=${PIPESTATUS[0]}
  fi
fi

if echo ",${SKIP}," | grep -q ",r,"; then
  sub "GATE_SKIP contains r — restart lanes skipped"
  RC_RESTART=0
else
  R_ENV=(TGZ="$TGZ" REPO="$REPO" WORKDIR="$WORK"
    MODEL1_BASE_URL="$MODEL1_BASE_URL" MODEL1_MODEL="$MODEL1_MODEL" MODEL1_API_KEY="$MODEL1_API_KEY"
    GATE_AGENTS="${GATE_AGENTS_R:-${GATE_AGENTS:-dsh,pi}}"
    GATE_TURN_TIMEOUT_MS="${GATE_TURN_TIMEOUT_MS:-300000}"
    GATE_R_CORPUS_TOKENS="${GATE_R_CORPUS_TOKENS:-80000}"
    GATE_R_WINDOW="${GATE_R_WINDOW:-16384}"
    GATE_R_CAP_RATIO="${GATE_R_CAP_RATIO:-0.4}"
    GATE_R_CACHE_RATIO="${GATE_R_CACHE_RATIO:-0.5}")
  if [ "$CONCURRENT" = "1" ]; then
    ( env "${R_ENV[@]}" node /gate-tools/restart-lanes.mjs 2>&1 | tee "$WORK/restart-lanes.log"
      echo "${PIPESTATUS[0]}" > "$WORK/.rc-restart" ) &
    R_PID=$!
  else
    env "${R_ENV[@]}" node /gate-tools/restart-lanes.mjs 2>&1 | tee "$WORK/restart-lanes.log"
    RC_RESTART=${PIPESTATUS[0]}
  fi
fi

# Wait for whichever lane group(s) were launched in the background and pick up
# their exit codes from the rc files (the subshell itself always exits 0).
if [ -n "$P_PID" ]; then
  wait "$P_PID"
  if [ -f "$WORK/.rc-plugins" ]; then RC_PLUGINS=$(cat "$WORK/.rc-plugins"); else RC_PLUGINS=2; fi
fi
if [ -n "$R_PID" ]; then
  wait "$R_PID"
  if [ -f "$WORK/.rc-restart" ]; then RC_RESTART=$(cat "$WORK/.rc-restart"); else RC_RESTART=2; fi
fi

# ---- 6. container-only lanes ---------------------------------------------------
log "6. docker lanes (Lane I install / Lane X auto-update)"
env \
  TGZ="$TGZ" VERDACCIO=$VDC_URL \
  VERDACCIO_NPMRC="$WORK/verdaccio.npmrc" \
  WORKDIR="$WORK" REPO="$REPO" GATE_SKIP="$SKIP" \
  node /gate-tools/docker-lanes.mjs 2>&1 | tee "$WORK/docker-lanes.log"
RC_LANES=${PIPESTATUS[0]}

kill "$VDC_PID" 2>/dev/null || true

# ---- 6.5. make the evidence readable for the invoking (non-root) user -----------
# Everything above ran as root; without this the host user can't open the
# per-lane bili.log / session dirs after the run (files are 0600 root).
if [ -n "${GATE_UID:-}" ] && [ "$GATE_UID" != "0" ]; then
  GATE_GID="${GATE_GID:-$GATE_UID}"
  log "6.5 chown evidence $WORK -> uid=$GATE_UID gid=$GATE_GID"
  chown -R "$GATE_UID:$GATE_GID" "$WORK" || log "WARN: chown failed — evidence may be unreadable outside the container"
fi

# ---- summary --------------------------------------------------------------------
log "SUMMARY"
echo "repo $GATE_REPO_URL @ $GATE_REV ($REV_SHA) — candidate $V"
echo "gate-local exit=$RC_GATE | plugin-lanes exit=$RC_PLUGINS | restart-lanes exit=$RC_RESTART | docker-lanes exit=$RC_LANES"
echo "evidence: $WORK (gate-local.log, plugin-lanes.log, restart-lanes.log, docker-lanes.log, verdaccio.log, gate-scratch/, plugin-lanes/, restart-lanes/)"
if [ "$RC_GATE" = "0" ] && [ "$RC_LANES" = "0" ] && [ "$RC_PLUGINS" = "0" ] && [ "$RC_RESTART" = "0" ]; then
  echo "OVERALL: GREEN"
  exit 0
else
  echo "OVERALL: RED"
  exit 1
fi
