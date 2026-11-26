# billion-context real-model gate container
#
# Self-contained: clone + build master, run the release gate (real compression /
# model switch / cache / install / auto-update) against whatever model API the
# runner passes in. Works identically on any Linux Docker host and on Docker
# Desktop for Windows — the only inputs are env vars.
#
#   docker build -t bili-gate .
#   docker run --rm \
#     -e MODEL1_BASE_URL=...  -e MODEL1_MODEL=...  -e MODEL1_API_KEY=... \
#     -e MODEL2_BASE_URL=...  -e MODEL2_MODEL=...  -e MODEL2_API_KEY=... \
#     -v "$PWD/out:/work" bili-gate
#
# MODEL1 = primary lane (compression / fold / cache)   [required]
# MODEL2 = second DIFFERENT upstream for the switch lane [optional; Lane B skipped if absent]

FROM node:22-slim

# git   — clone the repo under test (build-info stamps the commit)
# curl  — verdaccio user bootstrap
# ca-certificates — https to npm / model APIs
# APT_MIRROR lets slow regions swap deb.debian.org for a nearby mirror
# (build arg only — the published default stays the official source).
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Toolchain pinned to the surfaces the gate relies on:
#  - dsh 0.2.0-rc.2 = the CLI surface scripts/release-gate-local.mjs drives
#    (`dsh --profile <n> headless --json --session-id`)
#  - pnpm 9 = what dsh profiles use to materialize node_modules
#  - verdaccio = in-container registry for the install/update lanes (no host deps)
# Host CLIs for the plugin lanes (Lane P) — pinned to the same versions the
# repo's own CI uses (ci-e2e-pi-ws/codex-persona/native-opencode) so the gate
# tests the same surfaces the project tests:
#  - pi-stable: NOTE the package ships only the `pi-stable` bin; the canonical
#    `pi` symlink to dist/cli.js is created below (same as CI).
#  - codex 0.147.0 = the pinned persona-lane version (#815)
#  - opencode v2=2.0.20 global; v1=1.14.47 in /opt (the v1 line lives in the
#    `opencode-ai` package — @opencode/cli 1.x/2.x are the v2 line; same bin
#    name, so v1 is installed into a separate prefix as `opencode-v1`)
#  - claude-code = anthropic-wire host for protocol coverage
ARG CLAUDE_CODE_VERSION=2.0.76
RUN npm install -g --no-audit --no-fund \
      pnpm@12.4.2 \
      @deepseek-ai/dsh@0.2.0-rc.2 \
      verdaccio@6.10.5 \
      pi-stable@0.83.6 \
      @openai/codex@0.147.0 \
      @opencode/cli@2.0.20 \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && ln -sf "$(npm root -g)/pi-stable/dist/cli.js" /usr/local/bin/pi \
 && mkdir -p /opt/opencode-v1 \
 && npm install --prefix /opt/opencode-v1 --no-audit --no-fund opencode-ai@1.14.47 \
 && ln -sf /opt/opencode-v1/node_modules/.bin/opencode /usr/local/bin/opencode-v1

ENV LANG=C.UTF-8
ENV HOME=/root
ENV GATE_REPO_URL=https://github.com/ranxianglei/billion-context.git
ENV GATE_REV=master
# opencode v1 lives at /opt (bin name clash with the v2 global)
ENV GATE_OC1_BIN=opencode-v1

# gate-tools = the orchestrator + container-only lanes (COPY'd, not cloned)
RUN mkdir -p /gate /gate-tools /work
COPY entrypoint.sh docker-lanes.mjs plugin-lanes.mjs restart-lanes.mjs wire-lanes.mjs upstream-recorder.mjs patch-gate.mjs verdaccio.config.yaml /gate-tools/

ENTRYPOINT ["/bin/bash", "/gate-tools/entrypoint.sh"]
