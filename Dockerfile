# billion-context proxy in a container (#3389).
#
# Installs the published npm package at build time (the tested artifact — no
# source is compiled in the image) and runs the proxy as a long-lived service.
#
#   docker build -t billion-context .
#   docker run -d --name bili -p 8787:8787 \
#     -v bili-config:/root/.config/billion-context \
#     -v bili-data:/root/.local/share/billion-context \
#     -v bili-cache:/root/.cache/billion-context \
#     -v bili-state:/root/.local/state/billion-context \
#     billion-context
#
# Updates: rebuild/pull a newer image. In-container self-update is OFF by
# default (ACP_AUTO_UPDATE=0) so the running copy can never silently drift
# from its image version; opt back in with `-e ACP_AUTO_UPDATE=1`. Pin a
# release with `--build-arg BILI_VERSION=<version>` (default: latest).

FROM node:24-slim

ARG BILI_VERSION=latest
RUN npm install -g --no-audit --no-fund "billion-context@${BILI_VERSION}"

ENV ACP_AUTO_UPDATE=0

EXPOSE 8787

VOLUME ["/root/.config/billion-context", "/root/.local/share/billion-context", "/root/.cache/billion-context", "/root/.local/state/billion-context"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/__bili/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bili", "--host", "0.0.0.0", "--port", "8787"]
